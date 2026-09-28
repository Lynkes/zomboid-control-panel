import { useEffect, useReducer } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { cn, formatUptime } from '@/lib/utils'

interface ServerUptimeProps {
  /**
   * When the game server's process (or container) started, as the server
   * reported it (ISO string) -- the OS's own answer, never a guess. null or
   * undefined means the panel couldn't tell.
   */
  startedAt: string | null | undefined
  /**
   * Say "uptime unknown" instead of rendering nothing when there is no start
   * time. For a place where the server is known to be up, so a missing
   * uptime would otherwise just look like a missing feature.
   */
  showUnknown?: boolean
  className?: string
}

/**
 * How long the game server has been up, counted live from its start time.
 *
 * The dashboard used to print a duration the server computed at poll time,
 * so it only moved when the next 15s poll landed and froze outright while
 * polls failed. Counting from the start timestamp here keeps it right
 * between polls. Seconds only for the first minute, then whole minutes, and
 * the timer wakes only when the text would actually change -- a header
 * ticking every second is motion that pulls the eye for no information.
 */
export function ServerUptime({ startedAt, showUnknown = false, className }: ServerUptimeProps) {
  const { t, i18n } = useTranslation('serverUptime')
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const known = Number.isFinite(startMs)
  const elapsedMs = known ? Math.max(0, Date.now() - startMs) : 0

  useEffect(() => {
    if (!known) return
    const stepMs = elapsedMs < 60_000 ? 1000 : 60_000
    const timer = setTimeout(rerender, stepMs - (elapsedMs % stepMs))
    return () => clearTimeout(timer)
  })

  if (!known) {
    if (!showUnknown) return null
    return (
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)} title={t('unknownHint')}>
        <Clock className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
        {t('unknown')}
      </span>
    )
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  const shownSeconds = elapsedSeconds < 60 ? elapsedSeconds : elapsedSeconds - (elapsedSeconds % 60)
  const started = new Date(startMs)
  return (
    <time
      dateTime={started.toISOString()}
      title={t('startedAt', {
        time: started.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
      })}
      className={cn('inline-flex items-center gap-1 whitespace-nowrap tabular-nums', className)}
    >
      <Clock className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      {t('up', { uptime: formatUptime(shownSeconds) })}
    </time>
  )
}
