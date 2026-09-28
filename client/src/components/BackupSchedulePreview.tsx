import { AlertCircle, CheckCircle2, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BackupScheduleValidation } from '@/lib/api'
import { backupScheduleErrorText } from '@/hooks/useBackupScheduleCheck'
import { cn } from '@/lib/utils'

// What useBackupScheduleCheck() found, drawn the same way under both
// backup-schedule editors (the Backups page's custom cron field and
// Settings > Backups' Schedule field) -- so the two can't disagree in how
// they look any more than in what they accept. `pending` dims a verdict
// whose schedule has since been edited (and marks it aria-busy) until the
// newer check replaces it in place.

// "Valid schedule", or the server's reason it isn't, right under the field.
export function BackupScheduleValidity({
  check,
  pending,
}: {
  check: BackupScheduleValidation | null
  pending: boolean
}) {
  const { t } = useTranslation('backups')
  if (!check) return null
  return (
    <p
      className={cn(
        'flex items-center gap-1.5 text-xs transition-opacity',
        check.valid ? 'text-primary' : 'text-destructive',
        pending && 'opacity-60',
      )}
      aria-live="polite"
      aria-busy={pending || undefined}
    >
      {check.valid ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      {check.valid ? t('settingsPanel.customValid') : backupScheduleErrorText(check, t('settingsPanel.customInvalid'))}
    </p>
  )
}

// When a valid schedule would next back up, and the zone its fields are
// read in.
//
// `backupsEnabled`: whether scheduled backups are on. The schedule can be
// edited and saved while they're off, but "Next backup: <date>" would then
// be false -- nothing runs until the switch is on -- so that line says so
// instead. Unknown (status not loaded) shows neither: no claim either way.
export function BackupScheduleNextRun({
  check,
  pending,
  backupsEnabled,
  className,
}: {
  check: BackupScheduleValidation | null
  pending: boolean
  backupsEnabled: boolean | undefined
  className?: string
}) {
  const { t, i18n } = useTranslation('backups')
  if (!check?.valid) return null

  // Next run in the scheduler's own timezone -- the zone the cron fields
  // (and the restart-overlap times beside it) are written in -- so the
  // three agree even when this browser sits in a different zone than the
  // panel. Labelled with that zone: every other time on these pages (Last
  // Backup, "due since", attempt times) is in the browser's zone, and a UTC
  // container behind a local browser would otherwise put two unmarked
  // times hours apart side by side. Spelled out field by field because
  // Intl refuses timeZoneName alongside dateStyle/timeStyle (a TypeError
  // that the catch below would quietly turn into an unlabelled time).
  const formatInZone = (iso: string, timeZone: string): string => {
    try {
      return new Date(iso).toLocaleString(i18n.language, {
        timeZone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    } catch {
      const date = new Date(iso)
      return date.toLocaleDateString(i18n.language) + ' ' + date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
    }
  }

  return (
    <div
      className={cn('space-y-1 text-xs text-muted-foreground transition-opacity', pending && 'opacity-60', className)}
      aria-busy={pending || undefined}
    >
      {backupsEnabled === true && check.nextRun && (
        <p className="flex items-center gap-1">
          <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
          {t('settingsPanel.nextRun', { date: formatInZone(check.nextRun, check.timezone) })}
        </p>
      )}
      {backupsEnabled === false && <p>{t('settingsPanel.scheduledBackupsOff')}</p>}
      <p>{t('settingsPanel.timezoneNotice', { tz: check.timezone })}</p>
    </div>
  )
}
