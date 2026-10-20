import { useTranslation } from 'react-i18next'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'

type BridgeState = 'connected' | 'waiting' | 'offline' | 'loading'

interface BridgeStatusBadgeProps {
  connected: boolean
  running?: boolean
  loading?: boolean
  bridgePath?: string | null
  summary?: string | null
  className?: string
  // Set to false only where the badge already lives inside the Settings ->
  // Bridge tab it would link to (a self-link there is dead weight, not a
  // destination). Every other call site gets a real link for free.
  interactive?: boolean
}

const TONE: Record<BridgeState, StatusTone> = {
  connected: 'ok',
  waiting: 'warn',
  offline: 'error',
  loading: 'busy',
}

export function BridgeStatusBadge({ connected, running, loading, bridgePath, summary, className, interactive = true }: BridgeStatusBadgeProps) {
  const { t } = useTranslation('bridgeStatusBadge')
  const state: BridgeState = loading ? 'loading' : connected ? 'connected' : running ? 'waiting' : 'offline'

  const config: Record<BridgeState, { label: string; hint?: string }> = {
    connected: { label: t('connected.label') },
    waiting: { label: t('waiting.label'), hint: t('waiting.hint') },
    offline: { label: t('offline.label'), hint: t('offline.hint') },
    loading: { label: t('loading.label') },
  }

  const c = config[state]
  const tooltip = [
    summary || c.hint,
    bridgePath ? t('path', { path: bridgePath }) : null,
  ].filter(Boolean).join('\n')
  // role="status" does not derive an accessible name from its own visible
  // text (only interactive/content-naming roles do) -- without this, a
  // screen reader announces nothing at all when there's no hint/path (e.g.
  // connected/loading), and when there IS a title it becomes the entire
  // name via the last-resort title fallback, silently dropping the leading
  // state word. Building the name explicitly covers every state the same way.
  const accessibleName = [c.label, tooltip].filter(Boolean).join('\n')

  return (
    <StatusPill
      tone={TONE[state]}
      pulse={state === 'waiting'}
      label={c.label}
      title={tooltip || undefined}
      aria-live="polite"
      aria-label={accessibleName}
      className={className}
      {...(interactive ? { to: '/settings?tab=bridge' } : { role: 'status' })}
    />
  )
}
