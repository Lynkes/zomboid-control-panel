import { useEffect, useRef, useState } from 'react'
import { backupApi, type BackupScheduleValidation } from '@/lib/api'
import { resolveRegisteredTranslation } from '@/lib/paramTranslation'

// The backup schedule has two editors: the Backups page's Backup Frequency
// picker (presets, or "Custom (cron expression)") and the raw Schedule field
// on Settings > Backups. Both judge what's typed through this one module --
// POST /backup/validate-schedule, which runs the exact checks POST
// /backup/settings saves under -- so neither can call "valid" what the other
// rejects, or what the save then refuses. Settings used to check a local
// regex instead: no bounds, no names, no 5-minute floor, so "99 * * * *"
// passed there and failed on save, and "0 3 * * MON" was refused there but
// accepted everywhere else (the same split 37e297c9 closed for the
// Scheduler's cron field).

// Live preview of `schedule` while `active`: validity, next run (in the
// scheduler's timezone) and the scheduled restarts it would land inside.
// Advisory -- same contract as the Scheduler page's cron preview: it never
// blocks Save on its own, the server re-validates.
//
// Debounced by the effect's own cleanup, with a generation counter so a
// slow answer can't land over a newer one. The newest verdict stays
// available while the check for a newer edit is pending (`pending`, for the
// caller to dim and mark aria-busy) instead of the whole preview collapsing
// on every keystroke and moving everything below it. Cleared only for an
// empty field, a failed check, or `active` going false -- which also drops
// a check still in flight, so reopening starts from fresh data.
//
// `active` must be false for a role without backups.manage: the endpoint is
// gated on it (403), and such a role can't save a schedule anyway.
export function useBackupScheduleCheck(schedule: string, active: boolean) {
  // Keyed by the schedule it answers for, so a verdict for what was typed a
  // moment ago is never presented as current for what is typed now.
  const [check, setCheck] = useState<{ schedule: string; result: BackupScheduleValidation } | null>(null)
  const checkIdRef = useRef(0)

  useEffect(() => {
    if (!active || !schedule) {
      checkIdRef.current++
      setCheck(null)
      return
    }
    const checkId = ++checkIdRef.current
    const timer = setTimeout(() => {
      backupApi.validateSchedule(schedule)
        .then((result) => {
          if (checkIdRef.current !== checkId) return
          setCheck({ schedule, result })
        })
        // A failed preview says nothing about the schedule itself, so it
        // just shows nothing; Save still validates server-side.
        .catch(() => {
          if (checkIdRef.current !== checkId) return
          setCheck(null)
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [active, schedule])

  const shown = schedule ? check?.result ?? null : null
  return { check: shown, pending: shown !== null && check?.schedule !== schedule }
}

// The save-time half: the same server check, awaited, so a typo gets its
// specific reason ("more often than every 5 minutes") instead of a generic
// failed save. Resolves to the rejection, or null when the schedule is
// valid -- or when the check itself couldn't run (network, 500): then the
// save goes ahead and POST /backup/settings, which applies the identical
// rules, has the final word.
export async function precheckBackupSchedule(
  schedule: string,
): Promise<{ error?: string; code?: string } | null> {
  try {
    const check = await backupApi.validateSchedule(schedule)
    return check.valid ? null : check
  } catch {
    return null
  }
}

// A rejected schedule, in the operator's language: the registered error
// code's translation, else the server's own sentence, else `fallback`.
export function backupScheduleErrorText(
  check: { error?: string; code?: string },
  fallback: string,
): string {
  return (check.code && resolveRegisteredTranslation('errors', check.code, undefined)) || check.error || fallback
}
