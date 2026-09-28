import { useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { HelpTip } from '@/components/HelpTip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, splitUptime } from '@/lib/utils'

// A start time further ahead of this browser's clock than this is a clock
// problem, not a server that is about to start: shown as unknown rather
// than as "up 0s" for however long the clocks disagree. The API layer
// already takes host/browser skew out (lib/hostClock.ts); this catches
// what it can't, such as a payload from a server too old to send its clock.
const MAX_FUTURE_START_MS = 60_000

// How far apart two reports of the start time may be and still describe
// the same process. hostClock.ts's skew correction leaves each response's
// own one-way latency in the value, so successive polls report the same
// start a few hundred ms apart -- enough to step the count backwards across
// a boundary ("up 1m" back to "up 59s"). A restart moves it by the old
// process's whole uptime, and a host clock step by seconds at least.
const SAME_START_JITTER_MS = 2_000

interface ServerUptimeProps {
  /**
   * When the game server's process (or container) started, as the server
   * reported it (ISO string, already in this browser's clock -- see
   * lib/hostClock.ts) -- the OS's own answer, never a guess. null or
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
  const [startedOpen, setStartedOpen] = useState(false)

  // Of two reports within SAME_START_JITTER_MS of each other, the earlier
  // one: latency only ever makes a report late, so the earliest is the
  // closest to the truth, and keeping it means jitter can only move the
  // count forward. Anything further off is a different start, taken as is.
  // Held in state and adjusted while rendering -- React's pattern for state
  // derived from a changing prop.
  const reportedMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const [heldMs, setHeldMs] = useState(reportedMs)
  const startMs = Math.abs(reportedMs - heldMs) < SAME_START_JITTER_MS
    ? Math.min(reportedMs, heldMs)
    : reportedMs
  if (!Object.is(startMs, heldMs)) setHeldMs(startMs)

  const nowMs = Date.now()
  const known = Number.isFinite(startMs) && startMs <= nowMs + MAX_FUTURE_START_MS
  const elapsedMs = known ? Math.max(0, nowMs - startMs) : 0

  useEffect(() => {
    if (!known) return
    const stepMs = elapsedMs < 60_000 ? 1000 : 60_000
    const timer = setTimeout(rerender, stepMs - (elapsedMs % stepMs))
    return () => clearTimeout(timer)
  })

  if (!known) {
    if (!showUnknown) return null
    // The reason lives in a HelpTip, not a `title`: a title can't be opened
    // by touch or keyboard, and "unknown" next to the server's name with
    // no way to learn why reads like a fault.
    return (
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)}>
        <Clock className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
        {t('unknown')}
        <HelpTip label={t('unknown')}>{t('unknownHint')}</HelpTip>
      </span>
    )
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  const shownSeconds = elapsedSeconds < 60 ? elapsedSeconds : elapsedSeconds - (elapsedSeconds % 60)
  // Unit wording is the translators' (units.* in serverUptime.json), as for
  // every other duration in the UI -- not CLDR's narrow units, which put
  // "2г 3х" in Ukrainian and "1 T" in German next to the dashboard's own
  // "год"/"хв" and "Tg.".
  const uptime = splitUptime(shownSeconds)
    .map(({ unit, count }) => t(`units.${unit}`, { count }))
    .join(' ')
  const started = new Date(startMs)
  // The exact start is a tooltip on the uptime itself rather than a
  // `title`, for the same reason as the unknown state's HelpTip: the uptime
  // shows on phones, and a title opens by neither touch nor keyboard.
  // Focusable, and a tap opens it -- see HelpTip for why the click is
  // intercepted (Radix's trigger treats a click as "close").
  return (
    <Tooltip open={startedOpen} onOpenChange={setStartedOpen}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          event.preventDefault()
          setStartedOpen(true)
        }}
      >
        <time
          dateTime={started.toISOString()}
          tabIndex={0}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap rounded-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            className,
          )}
        >
          <Clock className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          {t('up', { uptime })}
        </time>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {t('startedAt', {
          time: started.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </TooltipContent>
    </Tooltip>
  )
}
