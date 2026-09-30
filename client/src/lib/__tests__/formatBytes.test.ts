import { describe, expect, it } from 'vitest'
import { formatBytes } from '../formatBytes'

describe('formatBytes', () => {
  it('steps by 1024 and keeps one decimal below 100', () => {
    expect(formatBytes(0, 'en')).toBe('0B')
    expect(formatBytes(258, 'en')).toBe('258B')
    expect(formatBytes(1536, 'en')).toBe('1.5 kB')
    expect(formatBytes(18.5 * 1024, 'en')).toBe('18.5 kB')
    expect(formatBytes(120 * 1024 * 1024, 'en')).toBe('120 MB')
    expect(formatBytes(2 * 1024 ** 3, 'en')).toBe('2 GB')
  })

  it('formats per language (digits and unit come from Intl)', () => {
    const arabic = formatBytes(1536, 'ar')
    expect(arabic).not.toBe('1.5 kB')
    expect(arabic.length).toBeGreaterThan(0)
    expect(formatBytes(1536, 'fr')).toMatch(/1,5/)
  })

  it('is empty for nothing to show', () => {
    expect(formatBytes(null, 'en')).toBe('')
    expect(formatBytes(undefined, 'en')).toBe('')
    expect(formatBytes(-1, 'en')).toBe('')
    expect(formatBytes(Number.NaN, 'en')).toBe('')
  })

  it('falls back to English for a language tag Intl rejects', () => {
    expect(formatBytes(1536, 'not a tag!')).toBe('1.5 kB')
  })
})
