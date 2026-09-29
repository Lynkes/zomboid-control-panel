import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { BackupScheduleNextRun } from '../BackupSchedulePreview'
import type { BackupScheduleValidation } from '@/lib/api'

// 1.4.0 pre-release bug round: node-cron, which fires the backup job, runs a
// schedule restricting both the day-of-month and the weekday ("0 4 1 * 1")
// only on days matching BOTH -- classic cron runs it on either. The preview's
// "Next backup" is node-cron's date now, which can be months away for such a
// schedule; the note says why, under both editors that share this component.

const NOTE = 'Day of month and weekday must both match: backups run only on days that satisfy both, not either one.'

const check = (bothDayFieldsRestricted?: boolean): BackupScheduleValidation => ({
  valid: true,
  nextRun: '2027-02-01T04:00:00.000Z',
  timezone: 'UTC',
  restartOverlaps: [],
  ...(bothDayFieldsRestricted === undefined ? {} : { bothDayFieldsRestricted }),
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('BackupScheduleNextRun: both day fields restricted', () => {
  it('explains the AND rule next to the next backup when the server flags the schedule', () => {
    render(<BackupScheduleNextRun check={check(true)} pending={false} backupsEnabled />)
    expect(screen.getByText(/^Next backup: .*2027.*UTC$/)).toBeInTheDocument()
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('says it even while scheduled backups are off -- it is about the schedule, not the switch', () => {
    render(<BackupScheduleNextRun check={check(true)} pending={false} backupsEnabled={false} />)
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('stays quiet for a schedule restricting one day field, or a server that does not say', () => {
    render(<BackupScheduleNextRun check={check(false)} pending={false} backupsEnabled />)
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
    cleanup()
    render(<BackupScheduleNextRun check={check()} pending={false} backupsEnabled />)
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('is translated (no raw key) in another locale', async () => {
    await i18n.changeLanguage('de')
    render(<BackupScheduleNextRun check={check(true)} pending={false} backupsEnabled />)
    expect(screen.getByText(/^Tag des Monats und Wochentag müssen beide passen/)).toBeInTheDocument()
    expect(screen.queryByText(/bothDayFieldsNote/)).not.toBeInTheDocument()
  })
})
