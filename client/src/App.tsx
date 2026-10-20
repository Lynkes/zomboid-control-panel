import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { DirectionProvider } from '@radix-ui/react-direction'
import type { Socket } from 'socket.io-client'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  FeatureErrorBoundary,
} from './components/FeatureErrorBoundary'
import { Toaster } from './components/ui/toaster'
import { SocketContext, ConnectionStatus, ConnectionStatusContext } from './contexts/SocketContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ConfirmProvider } from './contexts/ConfirmContext'
import { TooltipProvider } from './components/ui/tooltip'
import { useToast } from './components/ui/use-toast'
import { RoutePageSkeleton } from './components/PageSkeleton'
import { UnsavedChangesProvider } from './contexts/UnsavedChangesContext'
import { ROUTES, ROUTE_ALIASES } from './lib/navigation'
import { ScrollToTop } from './components/ScrollToTop'
import { AuthStatusError } from './components/AuthStatusError'
import { isDemoMode } from './lib/demo'
import { getUserErrorMessage } from './lib/errorMessage'
import { createSocketAuthProvider } from './lib/socketAuth'
import { createSocketAuthRetry, isSocketAuthRefusal } from './lib/socketAuthRetry'
import { registerReconnectRecovery } from './lib/socketRecovery'
import { isRTL } from './i18n'

const AUTH_BOOT_STEPS = [
  { code: 'AUTH', label: 'Verifying credentials' },
  { code: 'LINK', label: 'Opening control channel' },
  { code: 'SYNC', label: 'Restoring panel state' },
  { code: 'NET ', label: 'Pinging live servers' },
  { code: 'OK  ', label: 'Standing by' },
]

// Every routed page, lazy-loaded from the route registry (one chunk each).
const ROUTE_PAGES = ROUTES.map((route) => ({ route, Page: lazy(route.load) }))
const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))

// Loading fallback: the route's own skeleton, named after it in the
// operator's language (registry title, icon and description).
function PageLoader() {
  const { pathname } = useLocation()
  return <RoutePageSkeleton pathname={pathname} />
}

function AuthScreenLoader() {
  const [stepIndex, setStepIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const totalSteps = AUTH_BOOT_STEPS.length

  useEffect(() => {
    // Advances every 350ms (was 650ms) so the full sequence takes ~1.75s
    // instead of ~3.25s for 5 steps — this animation doesn't gate anything
    // (the parent swaps it out the instant real auth resolves), but a
    // shorter total duration means less of it is ever visibly cut off
    // mid-step on a fast resolution, and less of a screen seen many times a
    // day feels like padded theater.
    const stepTimer = window.setInterval(() => {
      setStepIndex((current) => Math.min(current + 1, totalSteps - 1))
    }, 350)
    const tickTimer = window.setInterval(() => {
      setTick((current) => (current + 1) % 4)
    }, 500)
    return () => {
      window.clearInterval(stepTimer)
      window.clearInterval(tickTimer)
    }
  }, [totalSteps])

  const now = new Date()
  // Real UTC, not local time — this used to be toTimeString() (LOCAL time)
  // mislabeled "UTC" below.
  const clock = now.toISOString().slice(11, 19)
  const dots = '·'.repeat(tick) + ' '.repeat(3 - tick)
  const progress = Math.round(((stepIndex + 1) / totalSteps) * 100)
  const segments = 24
  const lit = Math.round((segments * (stepIndex + 1)) / totalSteps)

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-10">
      {/* Atmospheric backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 50% 30%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(circle at 12% 110%, hsl(var(--destructive) / 0.10), transparent 45%), linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
        }}
      />
      <div aria-hidden="true" className="control-room-sweep absolute inset-0 opacity-40" />
      {/* Vignette */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 220px 40px hsl(var(--background))' }}
      />

      {/* Top status bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
        <span>Project Zomboid // Control Panel</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 shadow-[0_0_8px_hsl(var(--primary)/0.6)]" />
          <span>Secure Handshake</span>
        </span>
      </div>

      {/* Bottom status bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/60">
        <span>{clock} UTC</span>
        <span>STAND BY{dots}</span>
        <span>{progress.toString().padStart(3, '0')}%</span>
      </div>

      {/* Center stage */}
      <div className="relative w-full max-w-[520px]">
        {/* Corner brackets */}
        <span aria-hidden="true" className="pointer-events-none absolute -start-2 -top-2 h-5 w-5 border-s-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -end-2 -top-2 h-5 w-5 border-e-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -start-2 h-5 w-5 border-b-2 border-s-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -end-2 h-5 w-5 border-b-2 border-e-2 border-primary/45" />

        <div className="relative rounded-md border border-border/60 bg-card/70 px-6 py-7 backdrop-blur-sm shadow-[0_30px_80px_-50px_hsl(var(--foreground)/0.6)]">
          {/* Header strip */}
          <div className="mb-5 flex items-center justify-between border-b border-border/50 pb-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="text-primary/80">// boot.sequence</span>
            <span>node · admin</span>
          </div>

          {/* Hero row */}
          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}spiffo.png`}
                alt=""
                aria-hidden="true"
                className="h-16 w-16 select-none drop-shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
                style={{ imageRendering: 'pixelated' }}
                draggable={false}
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 ring-2 ring-card" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
                Establishing session
              </div>
              <div className="mt-1 truncate font-mono text-base font-semibold tracking-[0.18em] text-foreground">
                CONTROL ROOM ONLINE
              </div>
            </div>
          </div>

          {/* Boot log */}
          <ul className="mt-6 space-y-1.5 font-mono text-[11px] leading-tight" aria-live="polite">
            {AUTH_BOOT_STEPS.map((step, idx) => {
              const isDone = idx < stepIndex
              const isCurrent = idx === stepIndex
              const isPending = idx > stepIndex
              return (
                <li
                  key={step.code}
                  className={`flex items-center gap-3 transition-colors ${
                    isPending ? 'text-muted-foreground/35' : 'text-foreground/85'
                  }`}
                >
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-[3px] border text-[8px] font-semibold ${
                      isDone
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                        : isCurrent
                          ? 'border-primary/60 bg-primary/15 text-primary animate-pulse'
                          : 'border-border/50 bg-transparent text-muted-foreground/50'
                    }`}
                  >
                    {isDone ? '✓' : isCurrent ? '›' : '·'}
                  </span>
                  <span className="w-10 shrink-0 uppercase tracking-[0.18em] text-muted-foreground/70">
                    {step.code}
                  </span>
                  <span className="truncate">{step.label}</span>
                  {isCurrent && (
                    <span className="ms-auto text-[10px] uppercase tracking-[0.2em] text-primary/80">
                      …
                    </span>
                  )}
                  {isDone && (
                    <span className="ms-auto text-[10px] uppercase tracking-[0.2em] text-emerald-500/70">
                      OK
                    </span>
                  )}
                </li>
              )
            })}
          </ul>

          {/* Segmented progress */}
          <div className="mt-6 flex items-center gap-[3px]" aria-hidden="true">
            {Array.from({ length: segments }).map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 flex-1 rounded-[1px] transition-colors duration-300 ${
                  idx < lit
                    ? idx === lit - 1
                      ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]'
                      : 'bg-primary/70'
                    : 'bg-border/40'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function NotFoundRoute() {
  return (
    <div className="space-y-6 page-transition">
      <div className="rounded-xl border border-border/70 bg-card/70 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Page Not Found</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The route you requested does not exist or is no longer available in this panel build.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link to="/" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Go to Dashboard
          </Link>
          <Link to="/servers" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-background px-4 text-sm font-medium hover:bg-muted/50">
            Open Servers
          </Link>
        </div>
      </div>
    </div>
  )
}

function AppContent() {
  const { t } = useTranslation('shell')
  // The socket effect below must not restart (and drop the connection) when
  // the language changes, so its handlers read the translator through a ref.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const demoMode = isDemoMode()
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    reconnecting: false,
    // Until the first connect settles, so the footer does not flash (or, with
    // no socket at all, keep) a "Live Updates Unavailable" notice.
    connecting: true,
    reconnectAttempt: 0,
    error: null,
  })
  const { toast } = useToast()
  const { isAuthenticated, isLoading, needsSetup, authEnabled, statusCheckFailed, statusCheckCode, retryAuthCheck, getToken } = useAuth()

  const handleReconnectSuccess = useCallback(() => {
    toast({
      title: tRef.current('connection.reconnectedTitle'),
      description: tRef.current('connection.reconnectedDescription'),
      variant: 'success' as const,
    })
  }, [toast])

  useEffect(() => {
    // Don't connect socket until auth is resolved
    if (demoMode) return
    if (isLoading) return
    // Nothing on the setup screen uses the socket, and the server refuses
    // one until the first account exists (server/index.js's io.use). Once
    // setup signs in, needsSetup flips and this effect connects.
    if (needsSetup) return
    // If auth is enabled and user is not authenticated, don't connect
    if (authEnabled && !isAuthenticated) return

    let cancelled = false
    let createdSocket: Socket | null = null
    // Set only while a reconnect_failed recovery is pending (see below);
    // cleared on a successful connect so a recovery reached some other way
    // (the manual Retry button) doesn't leave a stale visibilitychange/
    // online listener registered for the rest of the session.
    let disposeRecovery: (() => void) | null = null
    // Retries a handshake the server refused for its token (connect_error).
    let authRetry: ReturnType<typeof createSocketAuthRetry> | null = null

    const setupSocket = async () => {
      const { io } = await import('socket.io-client')
      if (cancelled) return

      const newSocket = io(window.location.origin, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        autoConnect: false,
      })
      createdSocket = newSocket

      // Set when the server closes the connection because the access token
      // it was opened with expired (server/index.js, closeSocketAtTokenExpiry).
      // The reconnect that follows, with a refreshed token, is routine every
      // 15 minutes: it changes no status and shows no toast unless it fails.
      let tokenExpiryReconnect = false
      // Same event, but kept until a connect succeeds, so every attempt until
      // then refreshes first whatever this browser's clock says about the
      // token: the server's clock decided it expired.
      let tokenExpiredByServer = false
      const socketAuthRetry = createSocketAuthRetry(() => {
        if (!cancelled) newSocket.connect()
      })
      authRetry = socketAuthRetry
      newSocket.auth = createSocketAuthProvider(getToken, authEnabled, () => tokenExpiredByServer)
      newSocket.connect()

      newSocket.on('auth:token-expired', () => {
        tokenExpiryReconnect = true
        tokenExpiredByServer = true
      })

      // Connection established
      newSocket.on('connect', () => {
        disposeRecovery?.()
        disposeRecovery = null
        const routineReconnect = tokenExpiryReconnect
        tokenExpiryReconnect = false
        tokenExpiredByServer = false
        socketAuthRetry.reset()
        setConnectionStatus(prev => {
          // Show toast only on reconnect, not initial connect. error covers
          // a manual Retry after the automatic loop gave up.
          if (!routineReconnect && (prev.reconnecting || prev.reconnectAttempt > 0 || prev.error)) {
            handleReconnectSuccess()
          }
          return {
            connected: true,
            reconnecting: false,
            connecting: false,
            reconnectAttempt: 0,
            error: null,
          }
        })
        // Subscribe to updates
        newSocket.emit('subscribe:status')
        newSocket.emit('subscribe:players')
        newSocket.emit('subscribe:logs')
      })

      // Connection lost
      newSocket.on('disconnect', (reason) => {
        if (tokenExpiryReconnect && reason === 'transport close') return
        tokenExpiryReconnect = false
        setConnectionStatus(prev => ({
          ...prev,
          connected: false,
          connecting: false,
          error: reason === 'io server disconnect' ? tRef.current('connection.serverClosed') : null,
        }))
      })

      // Connection error with detailed logging (from Socket.IO best practices)
      newSocket.on('connect_error', (err) => {
        tokenExpiryReconnect = false // the routine reconnect failed: show it
        // The server refused the token, which socket.io never retries
        // (lib/socketAuthRetry.ts): try again a few times, each one
        // refreshing first, before the error and Retry show.
        if (!newSocket.active && authEnabled && isSocketAuthRefusal(err.message)
          && socketAuthRetry.schedule()) {
          tokenExpiredByServer = true
          setConnectionStatus(prev => ({
            ...prev,
            connected: false,
            connecting: false,
            reconnecting: true,
            // The popover reads "Attempt n/10": this retry is attempt 1 at least.
            reconnectAttempt: Math.max(prev.reconnectAttempt, 1),
          }))
          return
        }
        if (newSocket.active) {
          // Temporary failure, socket will automatically reconnect
          setConnectionStatus(prev => ({
            ...prev,
            connected: false,
            connecting: false,
            reconnecting: true,
            // socket.io reports reconnect_attempt only after its backoff, so
            // the first failure would otherwise read "Attempt 0/10".
            reconnectAttempt: Math.max(prev.reconnectAttempt, 1),
            error: getUserErrorMessage(err, tRef.current('connection.error')),
          }))
        } else {
          // Connection denied by server - needs manual reconnect
          setConnectionStatus({
            connected: false,
            reconnecting: false,
            connecting: false,
            reconnectAttempt: 0,
            error: getUserErrorMessage(err, tRef.current('connection.error')),
          })
        }
      })

      // Reconnection events
      newSocket.io.on('reconnect_attempt', (attempt) => {
        if (tokenExpiryReconnect) return
        setConnectionStatus(prev => ({
          ...prev,
          connecting: false,
          reconnecting: true,
          reconnectAttempt: attempt,
        }))
      })

      // socket.io's own reconnectionAttempts (10, with backoff) is left
      // alone -- that part already works. The defect was that giving up
      // was PERMANENT: once reconnect_failed fires, socket.io itself never
      // tries again, and the operator's only way back was F5.
      //
      // Three real events can mean "it's worth trying again now" -- all
      // event-driven, none a timer:
      //   1. the tab was hidden and just became visible again (the operator
      //      wasn't watching; a background tab can still exhaust all 10
      //      attempts while nobody's looking)
      //   2. the browser's network just came back (the actual trigger for
      //      a transient blip)
      //   3. the operator is looking straight at a dead connection with the
      //      tab visible and network fine the whole time -- neither (1) nor
      //      (2) can ever fire for them, so ConnectionStatus.tsx's Retry
      //      button is their only path back
      // All three call newSocket.connect() and nothing else -- the auth
      // function above is what actually does the refresh-if-needed work,
      // so there is exactly one implementation behind all three triggers.
      newSocket.io.on('reconnect_failed', () => {
        setConnectionStatus({
          connected: false,
          reconnecting: false,
          connecting: false,
          reconnectAttempt: 0,
          error: tRef.current('connection.reconnectFailed'),
        })
        toast({
          title: tRef.current('connection.lostTitle'),
          description: tRef.current('connection.lostDescription'),
          variant: 'destructive',
        })

        disposeRecovery?.() // replace, don't stack, if this fires more than once in a session
        disposeRecovery = registerReconnectRecovery(() => newSocket.connect())
      })

      setSocket(newSocket)
    }

    void setupSocket()

    return () => {
      cancelled = true
      disposeRecovery?.()
      authRetry?.dispose()
      createdSocket?.close()
    }
  }, [toast, handleReconnectSuccess, isLoading, isAuthenticated, authEnabled, needsSetup, getToken, demoMode])

  // Auth gate — show loading, setup, or login screens before main app
  if (isLoading) {
    return <AuthScreenLoader />
  }

  if (statusCheckFailed) {
    return <AuthStatusError code={statusCheckCode} onRetry={retryAuthCheck} />
  }

  if (needsSetup) {
    return (
      <Suspense fallback={<AuthScreenLoader />}>
        <>
          <Setup />
          <Toaster />
        </>
      </Suspense>
    )
  }

  if (authEnabled && !isAuthenticated) {
    return (
      <Suspense fallback={<AuthScreenLoader />}>
        <>
          <Login />
          <Toaster />
        </>
      </Suspense>
    )
  }

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <SocketContext.Provider value={socket}>
        <UnsavedChangesProvider>
          <Layout>
            <ScrollToTop />
            <Suspense fallback={<PageLoader />}>
              <Routes>
                {ROUTE_PAGES.map(({ route, Page }) => (
                  <Route
                    key={route.path}
                    path={route.path}
                    element={<FeatureErrorBoundary featureName={t(route.titleKey)}><Page /></FeatureErrorBoundary>}
                  />
                ))}
                {Object.entries(ROUTE_ALIASES).map(([from, to]) => (
                  <Route key={from} path={from} element={<Navigate to={to} replace />} />
                ))}
                {/* Users and Roles & Permissions are now tabs inside Settings -- these
                    keep old bookmarks/deep links working rather than 404ing them. */}
                <Route path="/roles" element={<Navigate to="/settings?tab=roles" replace />} />
                <Route path="/users" element={<Navigate to="/settings?tab=users" replace />} />
                <Route path="/sso" element={<Navigate to="/settings?tab=sso" replace />} />
                <Route path="*" element={<NotFoundRoute />} />
              </Routes>
            </Suspense>
          </Layout>
        </UnsavedChangesProvider>
        <Toaster />
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  )
}

function App() {
  // Radix's own direction detection (react-direction's useDirection) has NO
  // fallback to document.documentElement.dir -- without an explicit dir prop
  // or this Provider, every RTL-aware Radix primitive (Slider, Select,
  // Tabs, Accordion, Menu/DropdownMenu, ScrollArea, RovingFocus -- see
  // node_modules/@radix-ui/react-direction's own useDirection: `localDir ||
  // globalDir || "ltr"`, no third fallback) silently stays 'ltr' forever,
  // regardless of the app's actual active language. i18n.language (via
  // useTranslation, so this re-renders on every language switch, not just
  // at boot) is the reactive source of truth here, same as
  // applyDocumentDirection() uses for the <html dir> sync in i18n/index.ts.
  const { i18n } = useTranslation()
  return (
    <ErrorBoundary>
      <DirectionProvider dir={isRTL(i18n.language) ? 'rtl' : 'ltr'}>
        <ThemeProvider>
          <TooltipProvider>
            <AuthProvider>
              <ConfirmProvider>
                <AppContent />
              </ConfirmProvider>
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </DirectionProvider>
    </ErrorBoundary>
  )
}

export default App
