import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import type { ScheduleMessageKey } from '@/lib/api'
import { scheduledAttemptMessage, scheduledBackupHealth } from '../scheduledBackupHealth'

// One classifier for the Dashboard and the Backups page (2026-09-27 Discord
// report: a restart skip read as "Scheduled backup failing" forever, and a
// manual backup couldn't clear it).
describe('scheduledBackupHealth', () => {
  const at = '2026-09-27T04:00:00.000Z'

  it('is none when scheduling is off or nothing has run', () => {
    expect(scheduledBackupHealth(false, { success: false, message: 'x', executedAt: at })).toBe('none')
    expect(scheduledBackupHealth(true, null)).toBe('none')
  })

  it('is ok for a success', () => {
    expect(scheduledBackupHealth(true, { success: true, message: 'Created: a.zip', executedAt: at })).toBe('ok')
  })

  it('is failing for a real failure nothing has made up for', () => {
    expect(scheduledBackupHealth(true, { success: false, message: 'ENOSPC', executedAt: at, recoveredAt: null })).toBe('failing')
  })

  it('is ok once any later backup succeeded (manual or scheduled) -- the warning clears', () => {
    expect(
      scheduledBackupHealth(true, { success: false, message: 'ENOSPC', executedAt: at, recoveredAt: '2026-09-27T05:00:00.000Z' }),
    ).toBe('ok')
    expect(
      scheduledBackupHealth(true, {
        success: false, message: 'Skipped: a restart was in progress', executedAt: at,
        skipReason: 'restart', recoveredAt: '2026-09-27T05:00:00.000Z',
      }),
    ).toBe('ok')
  })

  it('is skippedForRestart -- not failing -- for an old restart-skip row', () => {
    expect(
      scheduledBackupHealth(true, { success: false, message: 'Skipped: a restart was in progress', executedAt: at, skipReason: 'restart' }),
    ).toBe('skippedForRestart')
  })
})

// Review of the merge: the stuck-restart row is the panel's own prose, and
// it reached every locale in English. The server sends a key and its
// numbers beside the English, which stays the fallback.
describe('scheduledAttemptMessage', () => {
  const ENGLISH = 'Not run: the server restart had been running for 28 min (5-minute warning) without finishing -- ...'

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders a keyed message in the current language', async () => {
    await i18n.changeLanguage('fr')
    expect(scheduledAttemptMessage(ENGLISH, 'restartStuck', { minutes: 28, warningMinutes: 5 })).toMatch(
      /^Non exécutée : le redémarrage du serveur durait depuis 28 min \(avertissement de 5 min\) sans se terminer/,
    )
    expect(scheduledAttemptMessage(ENGLISH, 'restartStuckSinceDue', { minutes: 110 })).toMatch(/n'était toujours pas terminé 110 min plus tard/)
  })

  it('keeps the numbers in order in Arabic (isolated from the RTL sentence)', async () => {
    await i18n.changeLanguage('ar')
    const text = scheduledAttemptMessage(ENGLISH, 'restartStuck', { minutes: 28, warningMinutes: 5 })
    expect(text).toContain('\u206628\u2069 دقيقة')
    expect(text).not.toContain('Not run')
  })

  it('falls back to the English message: no key (a raw error, an older server), an unknown key, or missing numbers', () => {
    expect(scheduledAttemptMessage('ENOSPC: no space left on device', null, null)).toBe('ENOSPC: no space left on device')
    expect(scheduledAttemptMessage(ENGLISH, undefined, undefined)).toBe(ENGLISH)
    expect(scheduledAttemptMessage(ENGLISH, 'somethingNewer' as ScheduleMessageKey, { minutes: 1 })).toBe(ENGLISH)
    expect(scheduledAttemptMessage(ENGLISH, 'restartStuck', { minutes: 28 })).toBe(ENGLISH)
    expect(scheduledAttemptMessage(null, null, null)).toBeNull()
  })
})
