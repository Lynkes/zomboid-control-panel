import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { BackupRestartOverlap } from '@/lib/api'
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
export function BackupRestartOverlapNotice({
  overlaps,
  className,
}: {
  overlaps: BackupRestartOverlap[] | undefined
  className?: string
}) {
  const { t } = useTranslation('backups')
  if (!overlaps || overlaps.length === 0) return null
  return (
    <Alert className={cn('border-warning/40 bg-warning/10', className)}>
      <AlertTriangle className="h-4 w-4 text-warning" />
      <AlertTitle className="text-warning">{t('restartOverlap.title')}</AlertTitle>
      <AlertDescription className="space-y-1 text-xs text-muted-foreground">
        {overlaps.map((overlap) => (
          <p key={`${overlap.kind}:${overlap.name ?? ''}:${overlap.cron}`}>
            {overlap.kind === 'autoRestart'
              ? t('restartOverlap.autoRestart', { backupTime: overlap.backupTime, restartTime: overlap.restartTime })
              : t('restartOverlap.task', {
                  backupTime: overlap.backupTime,
                  restartTime: overlap.restartTime,
                  // A task always has a name when created from the Scheduler
                  // page; the cron is the only other thing that identifies it.
                  name: overlap.name || overlap.cron,
                })}
          </p>
        ))}
        <p>{t('restartOverlap.consequence')}</p>
      </AlertDescription>
    </Alert>
  )
}
