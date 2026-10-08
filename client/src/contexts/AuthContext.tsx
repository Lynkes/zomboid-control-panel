import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { clearAccessToken, forgetSessionUser, getAccessToken, setAccessToken } from '../lib/authToken'
import { ApiError, apiFetch, endServerSession, handleResponse, refreshSession, signedOutInAnotherTab } from '../lib/api'
import { getUserErrorMessage } from '../lib/errorMessage'
import { getTrustedDeviceToken, rememberTrustedDeviceToken } from '../lib/trustedDevice'
import { toast } from '../components/ui/use-toast'
import { ToastAction } from '../components/ui/toast'
import i18n from '../i18n'

interface User {
  id: string
  username: string
  role: string
  // UX-only signal for hiding controls the caller's role can't use (e.g. a
  // Settings tab) -- NOT an access-control boundary; every route this could
  // gate is (and remains) independently enforced server-side via
  // requirePermission(). null means "couldn't resolve" (role renamed out
  // from under the session, a lookup failure, or an older cached response) --
  // treat that as "unknown", never as "no capabilities".
  capabilities: string[] | null
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  needsSetup: boolean
  authEnabled: boolean
  // GET /api/auth/status gave no usable answer (a 429, a 5xx, a proxy's
  // page, a network error), so whether logins are on is unknown. App shows
  // an error card with Retry rather than guess.
  statusCheckFailed: boolean
  // The code the panel itself refused that check with, when it sent one
  // (HOST_NOT_ALLOWED: opened by an address it does not answer to). The
  // card shows that reason rather than "wait and retry".
  statusCheckCode: string | null
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  setup: (username: string, password: string, rememberMe?: boolean, panelPort?: string, setupToken?: string) => Promise<void>
  // Resolves either way. When the panel never confirmed the sign-out, this
  // tab stays signed in and a toast offers Retry.
  logout: () => Promise<void>
  retryAuthCheck: () => void
  getToken: () => string | null
  // Fails OPEN: unknown capabilities (null, or no user yet) return true.
  // Hiding a UI control from a real administrator because a field failed to
  // load is a lockout-shaped support problem with no security benefit --
  // the server still says no to anyone who shouldn't be there regardless of
  // what this returns.
  can: (capability: string) => boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

const CORS_LOGIN_MESSAGE = 'Connection blocked by browser origin policy. For first-time reverse-proxy setup, set CORS_ORIGINS to this URL in the panel environment and restart it. Otherwise open the panel from a local/LAN address; after setup, manage origins in Settings > Remote Access.'

export const LOGIN_FAILED_MESSAGE = "We couldn't sign you in. Check your username and password and try again."

// Exported solely so its 5xx-vs-auth-failure branch can be unit tested
// directly (see __tests__/AuthContext.test.ts) without standing up a
// rendered AuthProvider + mocked fetch harness this file has never needed
// before -- the function itself has no dependency on component state.
export function getLoginErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return CORS_LOGIN_MESSAGE
  }
  if (error instanceof Error && /cors|origin policy|failed to fetch/i.test(error.message)) {
    return CORS_LOGIN_MESSAGE
  }
  // 2026-09-08 (auth-transport-parity): login() now goes through
  // lib/api.ts's shared apiFetch/fetchWithRetry instead of a raw fetch() --
  // that path already converts a browser-level CORS rejection (a TypeError,
  // usually "Failed to fetch") into an ApiError coded NETWORK_ERROR with a
  // different message ("Unable to reach the server...") before it ever
  // reaches this function, so neither check above can match it anymore. The
  // failure this branch exists to catch is unchanged; only its shape is.
  if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
    return CORS_LOGIN_MESSAGE
  }
  // 2026-09-08 (auth-transport-parity): login() now goes through
  // lib/api.ts's shared apiFetch/fetchWithRetry instead of a raw fetch() --
  // that path already converts a browser-level CORS rejection (a TypeError,
  // usually "Failed to fetch") into an ApiError coded NETWORK_ERROR with a
  // different message ("Unable to reach the server...") before it ever
  // reaches this function, so neither check above can match it anymore. The
  // failure this branch exists to catch is unchanged; only its shape is.
  // 2026-08-26: the enumeration ruling (revealing WHY authentication failed
  // -- wrong username vs. wrong password vs. locked account -- is an
  // account-enumeration oracle) only applies to an actual auth failure
  // (4xx). It says nothing about a genuine server error, which reveals no
  // information about the account either way -- collapsing a real 500 into
  // the identical "check your password" text was never required by that
  // ruling, just an accidental side effect of throwing a plain Error that
  // discarded the response status. A coded 5xx is preferred to the generic
  // fallback text here too, via getUserErrorMessage's normal precedence.
  if (error instanceof ApiError && typeof error.status === 'number' && error.status >= 500) {
    return getUserErrorMessage(error, LOGIN_FAILED_MESSAGE)
  }
  // bug-hunt-2026-09-07 (client silent-failure lane, error-code coverage
  // pass): a 429 from loginLimiter (server/routes/auth.js) used to fall
  // through this function's final `return LOGIN_FAILED_MESSAGE` right
  // alongside an actual wrong-password 401 -- the two are handled by the
  // same generic branch below, but that branch's text ("check your username
  // and password") is actively wrong for a rate-limited attempt, not merely
  // unspecific. The enumeration ruling this function exists to enforce is
  // about NOT revealing why an auth attempt failed; RATE_LIMIT_LOGIN doesn't
  // touch that at all -- "too many attempts" is identical regardless of
  // whether the account exists, so it can safely use its own already-
  // registered, already-translated text (errors.json) instead of being
  // swallowed into the credentials hint.
  if (error instanceof ApiError && error.status === 429) {
    return getUserErrorMessage(error, LOGIN_FAILED_MESSAGE)
  }
  return LOGIN_FAILED_MESSAGE
}

// Signing out tells this browser's other panel tabs (audit #16), which
// otherwise stayed fully usable until their access token ran out.
const AUTH_CHANNEL_NAME = 'pz-auth'
// The fallback where BroadcastChannel is missing: other tabs get a
// `storage` event when this key changes.
const SIGN_OUT_STORAGE_KEY = 'pz-auth-signed-out'

type AuthStatus = { needsSetup?: unknown; authEnabled?: unknown }

async function fetchAuthStatus(): Promise<{ status: AuthStatus | null; code: string | null }> {
  try {
    const res = await fetch('/api/auth/status')
    if (!res.ok) {
      let code: string | null = null
      try {
        const body = (await res.json()) as { code?: unknown } | null
        code = typeof body?.code === 'string' ? body.code : null
      } catch {
        // Not JSON (a proxy's page): no reason to show.
      }
      return { status: null, code }
    }
    const body: unknown = await res.json()
    return { status: body && typeof body === 'object' ? (body as AuthStatus) : null, code: null }
  } catch {
    return { status: null, code: null }
  }
}

function announceSignOut(channel: BroadcastChannel | null) {
  if (channel) {
    try {
      channel.postMessage({ type: 'logout' })
      return
    } catch {
      // Closed under us: fall back to storage below.
    }
  }
  try {
    localStorage.setItem(SIGN_OUT_STORAGE_KEY, String(Date.now()))
  } catch {
    // Storage blocked: other tabs find out at their next refresh.
  }
}

function showSignOutFailed(retry: () => void) {
  const retryLabel = i18n.t('authSession.retry', { ns: 'shell' })
  toast({
    variant: 'destructive',
    layout: 'stacked',
    title: i18n.t('authSession.signOutFailedTitle', { ns: 'shell' }),
    description: i18n.t('authSession.signOutFailedDescription', { ns: 'shell' }),
    // A minute, not the usual few seconds: whoever clicked Sign out has
    // likely turned away already, believing it done.
    duration: 60_000,
    action: (
      <ToastAction altText={retryLabel} onClick={retry}>
        {retryLabel}
      </ToastAction>
    ),
  })
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    needsSetup: false,
    authEnabled: true,
    statusCheckFailed: false,
    statusCheckCode: null,
  })
  const channelRef = useRef<BroadcastChannel | null>(null)

  // Get stored token
  const getToken = useCallback((): string | null => {
    return getAccessToken()
  }, [])

  // Check auth status and try auto-login
  const checkAuth = useCallback(async () => {
    // Step 1: Check if auth is needed. SECURITY (2026-10-08, audit #23):
    // only a real JSON answer saying so turns logins off. Any failure used
    // to, rendering the whole panel with no sign-out and no way to the
    // sign-in form, every call refused.
    const { status, code } = await fetchAuthStatus()
    if (!status) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        authEnabled: true,
        statusCheckFailed: true,
        statusCheckCode: code,
      }))
      return
    }

    if (status.needsSetup === true) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        needsSetup: true,
        authEnabled: false,
        statusCheckFailed: false,
        statusCheckCode: null,
      }))
      return
    }

    if (status.authEnabled === false) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: true,
        authEnabled: false,
        statusCheckFailed: false,
        statusCheckCode: null,
      }))
      return
    }

    try {
      // Step 2: Try existing token
      const token = getToken()
      if (token) {
        const meRes = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (meRes.ok) {
          const data = await meRes.json()
          setState({
            user: data.user,
            isAuthenticated: true,
            isLoading: false,
            needsSetup: false,
            authEnabled: true,
            statusCheckFailed: false,
            statusCheckCode: null,
          })
          return
        }
        // Token expired — try refresh
        clearAccessToken()
      }

      // Step 3: Try refresh token (httpOnly cookie sent automatically).
      // The shared refresh, so it waits its turn behind other tabs and
      // retries a REFRESH_RACE (audit #19).
      const refreshed = await refreshSession()
      if (refreshed.ok) {
        setState({
          user: refreshed.user,
          isAuthenticated: true,
          isLoading: false,
          needsSetup: false,
          authEnabled: true,
          statusCheckFailed: false,
          statusCheckCode: null,
        })
        return
      }
    } catch {
      // Fall through to the sign-in screen.
    }

    // Not authenticated
    setState(prev => ({
      ...prev,
      isLoading: false,
      isAuthenticated: false,
      authEnabled: true,
      statusCheckFailed: false,
      statusCheckCode: null,
    }))
  }, [getToken])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const retryAuthCheck = useCallback(() => {
    setState(prev => ({ ...prev, isLoading: true, statusCheckFailed: false, statusCheckCode: null }))
    void checkAuth()
  }, [checkAuth])

  useEffect(() => {
    const signedOutElsewhere = () => {
      // Drops this tab's token and a refresh it has in flight, too.
      signedOutInAnotherTab()
      setState(prev => (prev.authEnabled && prev.isAuthenticated
        ? { ...prev, user: null, isAuthenticated: false }
        : prev))
    }
    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL_NAME)
      channel.onmessage = (event: MessageEvent) => {
        if ((event.data as { type?: unknown } | null)?.type === 'logout') signedOutElsewhere()
      }
    } catch {
      channel = null
    }
    channelRef.current = channel
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIGN_OUT_STORAGE_KEY && event.newValue) signedOutElsewhere()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      channelRef.current = null
      channel?.close()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const login = useCallback(async (username: string, password: string, rememberMe = true) => {
    try {
      // 2026-09-08 (auth-transport-parity): was a raw fetch() constructing
      // its own ApiError by hand on failure -- that got the status/code
      // distinction getLoginErrorMessage() needs, but missed everything else
      // the shared transport already does for every other route (Retry-After
      // parsing, the fetchWithRetry timeout, consistent NETWORK_ERROR/TIMEOUT
      // classification). apiFetch/handleResponse throws an equivalent-or-
      // better ApiError on failure via the same buildResponseError() every
      // other call site uses.
      const data = await handleResponse<{ accessToken: string; user: AuthState['user']; deviceToken?: string }>(
        await apiFetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // Send/receive cookies
          // deviceToken: SECURITY (2026-10-05, A1), see lib/trustedDevice.ts.
          // Undefined (never signed in here) is dropped by JSON.stringify.
          body: JSON.stringify({ username, password, rememberMe, deviceToken: getTrustedDeviceToken(username) }),
        }),
      )
      setAccessToken(data.accessToken)
      rememberTrustedDeviceToken(data.user?.username ?? username, data.deviceToken)
      setState({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
        needsSetup: false,
        authEnabled: true,
        statusCheckFailed: false,
        statusCheckCode: null,
      })
    } catch (error) {
      throw new ApiError(getLoginErrorMessage(error), {
        status: error instanceof ApiError ? error.status : undefined,
      })
    }
  }, [])

  const setup = useCallback(async (username: string, password: string, rememberMe = true, panelPort = '3001', setupToken = '') => {
    let data: { accessToken: string; user: AuthState['user']; deviceToken?: string }
    try {
      // 2026-09-08 (auth-transport-parity): see login()'s own comment above
      // -- same swap, same reasoning.
      data = await handleResponse(
        await apiFetch('/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, password, rememberMe, panelPort, setupToken }),
        }),
      )
    } catch (error) {
      // Setup.tsx recognizes this exact message and swaps in a localized,
      // token-specific explanation instead of the generic setup-failed copy.
      // Untouched by the ApiError rethrow below: its own copy (see
      // setup.json's invalidSetupToken) is more specific than the
      // registered SETUP_TOKEN_REQUIRED translation, so it must keep
      // winning ahead of getUserErrorMessage() rather than being replaced
      // by it.
      if (error instanceof ApiError && error.code === 'SETUP_TOKEN_REQUIRED') {
        throw new Error('SETUP_TOKEN_REQUIRED')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError("We couldn't create the admin account. Try again.")
    }
    setAccessToken(data.accessToken)
    rememberTrustedDeviceToken(data.user?.username ?? username, data.deviceToken)
    setState({
      user: data.user,
      isAuthenticated: true,
      isLoading: false,
      needsSetup: false,
      authEnabled: true,
      statusCheckFailed: false,
      statusCheckCode: null,
    })
  }, [])

  const logout = useCallback(async () => {
    const attempt = async (): Promise<void> => {
      // SECURITY (2026-10-08, audit #14): a sign-out that never reached the
      // panel (a 502 while it restarts, a 429, a dropped connection) leaves
      // the 30-day refresh cookie working. Showing the sign-in screen then
      // would sign the next person at this browser in as this user, so the
      // tab stays signed in and says so instead.
      if (!(await endServerSession())) {
        showSignOutFailed(() => { void attempt() })
        return
      }
      clearAccessToken()
      // The next sign-in here may be anyone (see lib/authToken.ts).
      forgetSessionUser()
      announceSignOut(channelRef.current)
      setState(prev => ({
        ...prev,
        user: null,
        isAuthenticated: false,
      }))
    }
    await attempt()
  }, [])

  const can = useCallback(
    (capability: string) => {
      const capabilities = state.user?.capabilities
      if (capabilities == null) return true
      return capabilities.includes(capability)
    },
    [state.user],
  )

  return (
    <AuthContext.Provider value={useMemo(() => ({ ...state, login, setup, logout, retryAuthCheck, getToken, can }), [state, login, setup, logout, retryAuthCheck, getToken, can])}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useCapability(capability: string): boolean {
  const context = useContext(AuthContext)
  return context?.can(capability) ?? true
}
