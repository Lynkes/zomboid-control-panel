import { describe, expect, it } from 'vitest'
import { formatUptime, splitUptime } from '../utils'

// Server uptime shows on every Managed Servers card and on phones, in all
// nine UI languages, so its units are worded per locale -- by translators,
// in serverUptime.json (see ServerUptime.test.tsx), not by CLDR. This pins
// the split both share, and that formatUptime() itself still prints exactly
// what it always did for its other callers.

const SECONDS = 26 * 3600 + 3 * 60 // 1 day, 2 hours, 3 minutes

describe('splitUptime', () => {
  it('lists the non-zero units from days down to seconds', () => {
    expect(splitUptime(SECONDS)).toEqual([
      { unit: 'day', count: 1 },
      { unit: 'hour', count: 2 },
      { unit: 'minute', count: 3 },
    ])
    expect(splitUptime(3600 + 5)).toEqual([
      { unit: 'hour', count: 1 },
      { unit: 'second', count: 5 },
    ])
  })

  it('is 0 seconds for nothing, or for a negative duration', () => {
    expect(splitUptime(0)).toEqual([{ unit: 'second', count: 0 }])
    expect(splitUptime(-5)).toEqual([{ unit: 'second', count: 0 }])
  })
})

describe('formatUptime', () => {
  it('prints English unit letters, exactly as before', () => {
    expect(formatUptime(SECONDS)).toBe('1d 2h 3m')
    expect(formatUptime(5)).toBe('5s')
    expect(formatUptime(0)).toBe('0s')
  })
})
