import { cn } from '@/lib/utils'

/**
 * A single status signal from GET /api/servers/active/status (host, server,
 * or bridge). `status` carries provider-specific values (e.g. "running" vs
 * "unknown" vs "not-applicable") — see server/utils/serverStatusModel.js.
 */
export interface StatusSignal {
  status: string
  label: string
  detail?: string | null
}

interface ServerStatusBadgeProps {
  host?: StatusSignal | null
  server?: StatusSignal | null
  bridge?: StatusSignal | null
  /** Dot row + short summary text, for tight spaces like server cards. */
  compact?: boolean
  className?: string
}

type IndicatorState = 'online' | 'offline' | 'connecting' | 'unknown'

const INDICATOR_STATE: Record<string, IndicatorState> = {
  running: 'online',
  connected: 'online',
  active: 'online',
  stopped: 'offline',
  disconnected: 'offline',
  offline: 'offline',
  connecting: 'connecting',
  unknown: 'unknown',
  'not-applicable': 'unknown',
  'not-installed': 'unknown',
}

function toIndicatorState(status: string): IndicatorState {
  return INDICATOR_STATE[status] ?? 'unknown'
}

const DOT_CLASS: Record<IndicatorState, string> = {
  online: 'bg-muted-foreground/50',
  offline: 'bg-destructive',
  connecting: 'bg-warning animate-pulse',
  unknown: 'bg-muted-foreground/50',
}

const TEXT_CLASS: Record<IndicatorState, string> = {
  online: 'text-foreground',
  offline: 'text-destructive',
  connecting: 'text-warning',
  unknown: 'text-muted-foreground',
}

const DISPLAY_WORD: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  connected: 'Connected',
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  active: 'Active',
  offline: 'Offline',
  unknown: 'Unknown',
  'not-applicable': 'N/A',
  'not-installed': 'Not Installed',
}

function displayWord(status: string): string {
  return DISPLAY_WORD[status] ?? status
}

// Short form for the compact dot-row summary — "Up"/"Down" reads faster than
// per-signal wording ("Running"/"Connected"/"Active") in a tight card badge.
function shortWord(status: string): string {
  const state = toIndicatorState(status)
  if (state === 'online') return 'Up'
  if (state === 'offline') return 'Down'
  if (state === 'connecting') return 'Connecting'
  return status === 'not-installed' ? 'Not installed' : 'Unknown'
}

function CompactBadge({ signals, className }: { signals: StatusSignal[]; className?: string }) {
  const title = signals.map((s) => `${s.label}: ${displayWord(s.status)}`).join(' · ')
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)} title={title}>
      {signals.map((signal) => {
        const state = toIndicatorState(signal.status)
        return (
          <span key={signal.label} className={cn('inline-flex items-center gap-1 text-xs', TEXT_CLASS[state])}>
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASS[state])} aria-hidden="true" />
            {signal.label} {shortWord(signal.status)}
          </span>
        )
      })}
    </div>
  )
}

/**
 * Renders the provider-aware 3-signal server status (host / RCON / bridge)
 * so "container running, RCON down" never collapses into one misleading
 * "Stopped". Signals not passed in are simply omitted — used on server
 * cards where only the host signal is known for non-selected servers.
 */
export function ServerStatusBadge({ host, server, bridge, compact, className }: ServerStatusBadgeProps) {
  const signals = [host, server, bridge].filter((s): s is StatusSignal => Boolean(s))

  if (signals.length === 0) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>
  }

  if (compact) {
    return <CompactBadge signals={signals} className={className} />
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      {signals.map((signal) => {
        const state = toIndicatorState(signal.status)
        return (
          <span key={signal.label} role="status" className={cn('inline-flex items-center gap-1.5 text-xs', TEXT_CLASS[state])}>
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASS[state])} aria-hidden="true" />
            {signal.label}: {displayWord(signal.status)}
          </span>
        )
      })}
    </div>
  )
}
