import { describe, expect, it } from 'vitest'
import { buildSimpleCron, formatRelativeTime, nextCronRuns, parseSimpleCron } from '@/lib/cronSchedule'

// Scheduler redesign: the task dialog's friendly schedule modes save a cron,
// read a saved cron back, and preview the next runs in the panel's zone.

describe('parseSimpleCron / buildSimpleCron', () => {
  it('reads back every cron the builder writes', () => {
    const schedules = [
      { mode: 'daily' as const, hour: 6, minute: 30, everyHours: 1, days: [] },
      { mode: 'interval' as const, hour: 0, minute: 0, everyHours: 1, days: [] },
      { mode: 'interval' as const, hour: 0, minute: 0, everyHours: 6, days: [] },
      { mode: 'weekdays' as const, hour: 22, minute: 5, everyHours: 1, days: [0, 3, 5] },
    ]
    for (const schedule of schedules) {
      expect(parseSimpleCron(buildSimpleCron(schedule))).toEqual(schedule)
    }
  })

  it('reads the old builder crons and weekday ranges, and leaves the rest to Advanced', () => {
    expect(parseSimpleCron('0 4 * * *')).toMatchObject({ mode: 'daily', hour: 4, minute: 0 })
    expect(parseSimpleCron('0 */4 * * *')).toMatchObject({ mode: 'interval', everyHours: 4 })
    expect(parseSimpleCron('15 8 * * 1-5')).toMatchObject({ mode: 'weekdays', days: [1, 2, 3, 4, 5] })
    expect(parseSimpleCron('0 9 * * 7')).toMatchObject({ mode: 'weekdays', days: [0] })
    expect(parseSimpleCron('0 9 * * 0-6')).toMatchObject({ mode: 'daily' })
    for (const advanced of ['*/15 * * * *', '0 12 * * MON', '0 0 1 * *', '0 0 L * *', '0 0 0 * * *']) {
      expect(parseSimpleCron(advanced)).toBeNull()
    }
  })
})

describe('nextCronRuns', () => {
  // 2026-03-07 12:00 UTC: the day before US daylight saving starts.
  const from = Date.UTC(2026, 2, 7, 12, 0)

  it('lists the next runs at the wall-clock time of the schedule zone, across a DST change', () => {
    const runs = nextCronRuns('0 6 * * *', 'America/New_York', 3, from)
    expect(runs?.map((run) => new Date(run).toISOString())).toEqual([
      '2026-03-08T10:00:00.000Z', // 06:00 EDT (UTC-4) on the day the clocks go forward
      '2026-03-09T10:00:00.000Z',
      '2026-03-10T10:00:00.000Z',
    ])
  })

  it('handles intervals, weekday lists and named fields', () => {
    expect(nextCronRuns('0 */6 * * *', 'UTC', 3, from)?.map((run) => new Date(run).toISOString())).toEqual([
      '2026-03-07T18:00:00.000Z',
      '2026-03-08T00:00:00.000Z',
      '2026-03-08T06:00:00.000Z',
    ])
    // 2026-03-07 is a Saturday: the next Monday and Wednesday follow.
    expect(nextCronRuns('30 9 * * MON,WED', 'UTC', 2, from)?.map((run) => new Date(run).toISOString())).toEqual([
      '2026-03-09T09:30:00.000Z',
      '2026-03-11T09:30:00.000Z',
    ])
  })

  it('declines what it cannot read rather than guessing', () => {
    expect(nextCronRuns('0 0 L * *', 'UTC', 3, from)).toBeNull()
    expect(nextCronRuns('0 0 1 * MON', 'UTC', 3, from)).toBeNull()
    expect(nextCronRuns('0 0 0 * * *', 'UTC', 3, from)).toBeNull()
    expect(nextCronRuns('0 6 * * *', 'Not/AZone', 3, from)).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  it('says how far a run is from now, both ways', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0)
    expect(formatRelativeTime(now + 3 * 3_600_000, 'en', now)).toBe('in 3 hr.')
    expect(formatRelativeTime(now - 90 * 60_000, 'en', now)).toBe('1 hr. ago')
    expect(formatRelativeTime(null, 'en', now)).toBeNull()
  })
})
