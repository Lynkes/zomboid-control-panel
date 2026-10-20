import { StatusPill, type StatusTone } from '@/components/ui/status-pill'

type StatusState = 'online' | 'offline' | 'connecting' | 'unknown'

interface StatusIndicatorProps {
  state: StatusState
  label: string
  className?: string
}

const TONE: Record<StatusState, StatusTone> = {
  online: 'ok',
  offline: 'error',
  connecting: 'warn',
  unknown: 'idle',
}

export function StatusIndicator({ state, label, className }: StatusIndicatorProps) {
  return (
    <StatusPill
      role="status"
      aria-live="polite"
      tone={TONE[state]}
      pulse={state === 'connecting'}
      label={label}
      className={className}
    />
  )
}
