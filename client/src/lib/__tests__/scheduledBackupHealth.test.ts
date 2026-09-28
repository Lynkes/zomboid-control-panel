import { describe, expect, it } from 'vitest'
import { scheduledBackupHealth } from '../scheduledBackupHealth'

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
