import type { ScheduledBackupAttempt } from '@/lib/api'

// What the newest scheduled backup attempt means for the operator right now.
// Dashboard.tsx (verdict + Backups row) and Backups.tsx (Auto-Backup card)
// both read this one function, so they can't drift on what counts as
// "failing" -- the same reason both already read the same BackupStatus
// fields.
//
//   'none'              scheduling is off, or nothing has run yet
//   'ok'                the last attempt succeeded, OR it failed but a backup
//                       (manual or scheduled) has succeeded since -- the world
//                       has a fresh backup, so there is nothing left to fix
//   'skippedForRestart' an old panel dropped the backup because a restart was
//                       running (current servers wait for the restart instead)
//   'failing'           the backup itself broke and nothing has succeeded since
//
// 2026-09-27 Discord report: a restart schedule on the same cadence as the
// backup schedule made every scheduled attempt a restart skip, and the
// Dashboard called that "Scheduled backup failing" -- with no way to clear
// it, because a manual backup never touched the scheduled-attempt record.
export type ScheduledBackupHealth = 'none' | 'ok' | 'skippedForRestart' | 'failing'

export function scheduledBackupHealth(
  enabled: boolean | undefined,
  attempt: ScheduledBackupAttempt | null | undefined,
): ScheduledBackupHealth {
  if (!enabled || !attempt) return 'none'
  if (attempt.success || attempt.recoveredAt) return 'ok'
  if (attempt.skipReason === 'restart') return 'skippedForRestart'
  return 'failing'
}
