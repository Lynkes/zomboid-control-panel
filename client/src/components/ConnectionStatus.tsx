import { useEffect, useId, useRef, useState } from 'react'
import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useConnectionStatus, useSocket } from '@/contexts/SocketContext'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface ConnectionStatusProps {
  className?: string
  showLabel?: boolean
}

export function ConnectionStatus({ className, showLabel = false }: ConnectionStatusProps) {
  const { t } = useTranslation('connectionStatus')
  const { connected, reconnecting, reconnectAttempt, error } = useConnectionStatus()
  const socket = useSocket()
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const descriptionId = useId()
  // Set by Retry. A retry that works unmounts the notice, focused trigger
  // included, which would drop keyboard focus to <body>; the effect below
  // hands it to the page content instead.
  const retriedRef = useRef(false)
  useEffect(() => {
    if (!connected || reconnecting) return
    setOpen(false)
    if (!retriedRef.current) return
    retriedRef.current = false
    if (document.activeElement === document.body) {
      document.getElementById('main-content')?.focus({ preventScroll: true })
    }
  }, [connected, reconnecting])

  // Only show when not connected — a permanently visible "Connected" badge is noise
  if (connected && !reconnecting) return null

  // Reaching this component's render at all means the page itself loaded
  // over HTTP successfully -- so a stuck reconnect or a terminal disconnect
  // is never proof the panel/server is down, only that THIS live-update
  // connection specifically can't establish. A generic wifi-off icon with
  // no explanation reads as "the panel is broken" to a non-technical
  // operator; naming the likely cause (most commonly a reverse proxy not
  // forwarding WebSocket upgrades) turns this into something they can act
  // on or hand to whoever runs their proxy, without asserting it as fact --
  // plenty of other things can cause a socket to fail to connect.
  const getStatusInfo = () => {
    if (connected) {
      return {
        icon: Wifi,
        color: 'text-primary',
        surface: 'border-primary/20 bg-primary/10',
        label: t('connected.label'),
        description: t('connected.description'),
      }
    }
    if (reconnecting) {
      return {
        icon: Loader2,
        color: 'text-warning',
        surface: 'border-warning/24 bg-warning/10',
        label: t('reconnecting.label'),
        description: t('reconnecting.description', { attempt: reconnectAttempt }),
        // Only after a few attempts -- a single retry is normal network
        // noise, not evidence of a proxy misconfiguration worth surfacing.
        hint: reconnectAttempt >= 3 ? t('reconnecting.hint') : undefined,
        animate: true,
      }
    }
    return {
      icon: WifiOff,
      // Plain destructive red is about 2.4:1 on the dark card; this lighter
      // tint keeps the same hue at about 4.8:1.
      color: 'text-destructive dark:text-[hsl(6_70%_62%)]',
      surface: 'border-destructive/24 bg-destructive/10',
      label: t('disconnected.label'),
      description: t('disconnected.description'),
      hint: t('disconnected.hint'),
      technicalDetail: error ? t('disconnected.technicalDetail', { error }) : undefined,
      // The automatic reconnect loop has already given up by the time this
      // renders (App.tsx's reconnect_failed handler). It retries on its own
      // once the tab becomes visible again or the network comes back, but
      // an operator staring at a live, visible, network-fine tab the whole
      // time has neither of those events to rescue them -- this button is
      // their only path back short of a full page refresh. Calls the exact
      // same socket.connect(), which re-checks/refreshes the access token
      // first via the socket's auth function -- not a second, separate
      // reconnect implementation.
      showRetry: true,
    }
  }

  const status = getStatusInfo()
  const Icon = status.icon

  // A popover from a real button, not a hover tooltip: the explanation and
  // the Retry button inside it have to be reachable by tap and keyboard too.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            status.surface,
            connected && 'conn-status-breathing',
            className
          )}
        >
          <Icon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              status.color,
              status.animate && 'animate-spin'
            )}
            aria-hidden="true"
          />
          {showLabel && (
            <span className="min-w-0 flex-1 text-xs font-medium leading-4 text-foreground">
              {status.label}
            </span>
          )}
          {!showLabel && <span className="sr-only">{status.label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={showLabel ? 'top' : 'right'}
        className="w-72 p-3"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      >
        <div className="text-sm">
          <p id={labelId} className="font-medium">{status.label}</p>
          <p id={descriptionId} className="text-muted-foreground">{status.description}</p>
          {status.hint && (
            <p className="text-muted-foreground mt-1.5">{status.hint}</p>
          )}
          {status.technicalDetail && (
            <p className="text-muted-foreground/70 font-mono text-xs mt-1.5 break-all">
              {status.technicalDetail}
            </p>
          )}
          {status.showRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2 h-7 w-full text-xs"
              onClick={() => {
                // Close first, so focus returns to the trigger, which stays
                // put while the retry runs (it turns into "Reconnecting").
                retriedRef.current = true
                setOpen(false)
                socket?.connect()
              }}
            >
              {t('disconnected.retry')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Announces a dropped live-update connection to screen-reader users, who
// can't see the footer notice appear. Always rendered (empty while
// connected) so the live region exists before its text changes.
export function ConnectionAnnouncer() {
  const { t } = useTranslation('connectionStatus')
  const { connected, reconnecting } = useConnectionStatus()
  const message = connected && !reconnecting
    ? ''
    : t(reconnecting ? 'reconnecting.label' : 'disconnected.label')
  return <p role="status" className="sr-only">{message}</p>
}
