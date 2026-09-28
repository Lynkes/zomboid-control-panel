import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { splitUptime } from '../utils'
import { formatElapsed } from '../durationText'

// Server uptime shows on every Managed Servers card and on phones, in all
// ten UI languages, so its units are worded per locale -- by translators,
// in serverUptime.json (see ServerUptime.test.tsx), not by CLDR. This pins
// the split, and formatElapsed(), which words it for ServerUptime and for
// every other elapsed time that used to print English letters (Debug's
// uptimes, Settings > Bridge's diagnostic ages, Server Setup's resume
// banner): pt-BR's "Tempo ativo" read "3d 4h 5m" on Debug beside the
// Dashboard's "ativo há 3 d 4 h 5 min".

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

describe('formatElapsed', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('words each unit from the UI language, seconds only within the first minute', async () => {
    expect(formatElapsed(SECONDS + 42)).toBe('1d 2h 3m')
    expect(formatElapsed(45)).toBe('45s')
    expect(formatElapsed(0)).toBe('0s')

    await i18n.changeLanguage('pt-BR')
    expect(formatElapsed(SECONDS)).toBe('1 d 2 h 3 min')
    await i18n.changeLanguage('de')
    expect(formatElapsed(SECONDS)).toBe('1 Tg. 2 Std. 3 Min.')
  })

  // The server's formatAge() rounds: 90 s was "2m" in Settings > Bridge
  // while the Dashboard's uptime said 1 min for the same 90 s.
  it('floors, so one duration reads the same everywhere', () => {
    expect(formatElapsed(90)).toBe('1m')
    expect(formatElapsed(59.9)).toBe('59s')
  })

  it('is 0 seconds for a negative or non-finite duration', () => {
    expect(formatElapsed(-5)).toBe('0s')
    expect(formatElapsed(Number.NaN)).toBe('0s')
  })
})
