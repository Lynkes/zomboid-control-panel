import { describe, expect, it } from 'vitest'
import { formatUptime } from '../utils'

// Server uptime now shows on every Managed Servers card and on phones, in
// all nine UI languages -- where hard-coded English d/h/m/s letters inside a
// translated sentence read as "已运行 3d 4h 12m". With a locale, the unit
// letters come from CLDR through Intl instead.

const SECONDS = 26 * 3600 + 3 * 60 // 1 day, 2 hours, 3 minutes

describe('formatUptime', () => {
  it('prints English unit letters without a locale, exactly as before', () => {
    expect(formatUptime(SECONDS)).toBe('1d 2h 3m')
    expect(formatUptime(5)).toBe('5s')
    expect(formatUptime(0)).toBe('0s')
  })

  it('keeps English output identical when the locale is English', () => {
    expect(formatUptime(SECONDS, 'en')).toBe('1d 2h 3m')
    expect(formatUptime(0, 'en')).toBe('0s')
  })

  it('uses the locale\'s own narrow units', () => {
    expect(formatUptime(SECONDS, 'fr')).toBe('1j 2h 3min')
    expect(formatUptime(SECONDS, 'zh-CN')).toBe('1天 2小时 3分钟')
  })

  it('keeps Latin digits in a locale whose default numbering system is not Latin', () => {
    const arabic = formatUptime(SECONDS, 'ar')
    expect(arabic).toMatch(/1.*2.*3/)
    expect(arabic).not.toMatch(/[٠-٩]/)
  })

  it('falls back to English letters for a UI language the runtime does not know, or a bad tag', () => {
    expect(formatUptime(SECONDS, 'ht')).toBe('1d 2h 3m')
    expect(formatUptime(SECONDS, 'not a locale!')).toBe('1d 2h 3m')
  })
})
