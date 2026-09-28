import type { ScheduledBackupAttempt, ScheduleMessageKey, ScheduleMessageParams } from '@/lib/api'
import { extractTranslationParams, resolveRegisteredTranslation } from '@/lib/paramTranslation'

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

// A scheduled attempt's message in the operator's language. Most messages
// are raw errors passed on as they came (ENOSPC ..., a backup service
// refusal) and are shown as is. A few are prose the panel wrote itself -- a
// backup given up on because a restart looked stuck, with advice on what
// to do -- and those carry a key and their numbers: rendered from
// backups:scheduledAttempt.<key>. The English `message` is the fallback for
// an unknown key, missing params, or an older server that sends no key.
// Used for the newest attempt (Dashboard, Backups, Scheduler cards) and
// for every Schedule History row.
export function scheduledAttemptMessage(
  message: string | null | undefined,
  messageKey: ScheduleMessageKey | null | undefined,
  messageParams: ScheduleMessageParams | null | undefined,
): string | null {
  const translated = messageKey
    ? resolveRegisteredTranslation('backups', `scheduledAttempt.${messageKey}`, extractTranslationParams(messageParams))
    : null
  return translated ?? message ?? null
}
