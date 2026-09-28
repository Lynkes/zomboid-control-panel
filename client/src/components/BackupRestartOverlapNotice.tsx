import { AlertTriangle, CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { BackupRestartOverlap } from '@/lib/api'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import { cn } from '@/lib/utils'

// The backup schedule fires while a scheduled restart is still running
// (server/utils/backupRestartOverlap.js). The scheduler holds those backups
// until the restart finishes, so nothing is lost any more -- but they run
// late, and before that fix they were silently dropped (2026-09-27 Discord
// report: backup and restart both every 4 hours on the hour). Said up front
// on both pages where either schedule is looked at (Backups settings,
// Scheduler's backup-health card), so the operator can stagger the two
// instead of finding out from a late backup. Renders nothing when there is
// no overlap.
//
// `tone`: 'warning' where the operator is choosing times (the Backups
// settings panel, the Scheduler card) -- that is where it needs attention.
// 'neutral' for the standing notice on the main Backups page: a colliding
// backup is late, not lost, and an operator who backs up right after each
// restart on purpose shouldn't live with an amber banner they can't clear
// (DESIGN.md, Callouts).
//
// `live`: for the Backups settings panel, where this previews the schedule
// being edited and so can change while the operator types. A polite status
// region there instead of Alert's own role="alert" -- an advisory preview
// must not interrupt typing -- and `stale` dims it (aria-busy) while a check
// for a newer edit is pending, rather than the notice vanishing and coming
// back on every keystroke.
//
// The example times are in the scheduler's timezone, which the server sends
// with them; the notice names it, since the pages around it show
// browser-local times (a UTC Docker container behind a local browser puts
// the two hours apart). `hideTimeZone` where that zone is already on screen
// right beside it: the schedule preview's own timezone line, or the
// Scheduler's timezone card.
export function BackupRestartOverlapNotice({
  overlaps,
  tone = 'warning',
  live = false,
  stale = false,
  hideTimeZone = false,
  className,
}: {
  overlaps: BackupRestartOverlap[] | undefined
  tone?: 'warning' | 'neutral'
  live?: boolean
  stale?: boolean
  hideTimeZone?: boolean
  className?: string
}) {
  const { t } = useTranslation('backups')
  if (!overlaps || overlaps.length === 0) return null

  // The times are one example pair, never the whole set -- `allBackups`
  // picks the "every backup" wording when the example is the rule, so
  // "the 00:00 backup" doesn't read as if only midnight were affected.
  const describe = (overlap: BackupRestartOverlap): string => {
    const times = { backupTime: overlap.backupTime, restartTime: overlap.restartTime }
    if (overlap.kind === 'autoRestart') {
      return t(overlap.allBackups ? 'restartOverlap.autoRestartAll' : 'restartOverlap.autoRestart', times)
    }
    // A task always has a name when created from the Scheduler page, and
    // the cron is the only other thing that identifies it; both are null
    // for a role that can't read the Scheduler (server/routes/backup.js).
    const label = overlap.name || overlap.cron
    if (!label) {
      return t(overlap.allBackups ? 'restartOverlap.taskUnnamedAll' : 'restartOverlap.taskUnnamed', times)
    }
    return t(overlap.allBackups ? 'restartOverlap.taskAll' : 'restartOverlap.task', {
      ...times,
      name: overlap.name || isolateLtrForRtl(label),
    })
  }

  // Every overlap shares the one window: performRestart()'s default
  // countdown -- RESTART_WARNING_MINUTES, which the operator can change --
  // plus the typical save/relaunch tail. The example has to obey the rule
  // it illustrates, so it is picked from the window rather than fixed
  // (":30" beside "at least 35 min" would contradict it); past 45 there is
  // no tidy minute left in the hour to point at, so the sentence goes
  // without one. It only ever moves the backups: the other side may be
  // AUTO_RESTART_CRON, an environment variable, not a setting on a page.
  const windowMinutes = overlaps[0].windowMinutes
  const exampleMinute = [30, 45].find((minute) => minute >= windowMinutes)
  // One zone for every overlap -- they all come from the one scheduler.
  const timeZone = hideTimeZone ? undefined : overlaps[0].timezone

  const neutral = tone === 'neutral'
  return (
    <Alert
      role={live ? 'status' : undefined}
      aria-busy={stale || undefined}
      className={cn(
        neutral ? 'border-border/60 bg-muted/40' : 'border-warning/40 bg-warning/10',
        live && 'transition-opacity',
        stale && 'opacity-60',
        className,
      )}
    >
      {neutral ? (
        <CalendarClock className="h-4 w-4 text-primary" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-warning" />
      )}
      <AlertTitle className={neutral ? undefined : 'text-warning'}>{t('restartOverlap.title')}</AlertTitle>
      <AlertDescription className="space-y-1 text-xs text-muted-foreground">
        {overlaps.map((overlap, index) => (
          <p key={`${overlap.kind}:${index}`}>{describe(overlap)}</p>
        ))}
        <p>
          {exampleMinute !== undefined
            ? t('restartOverlap.consequence', {
                minutes: windowMinutes,
                // ":30" is all neutral characters -- an RTL sentence would
                // lay it out as "30:" without the isolate.
                exampleTime: isolateLtrForRtl(`:${exampleMinute}`),
              })
            : t('restartOverlap.consequenceNoExample', { minutes: windowMinutes })}
        </p>
        {timeZone && <p>{t('settingsPanel.timezoneNotice', { tz: timeZone })}</p>}
      </AlertDescription>
    </Alert>
  )
}
