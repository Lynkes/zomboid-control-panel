import { describe, expect, it } from 'vitest'
import { SANDBOX_SCHEMA, parseNumericSettingValue } from '../serverConfigSchema'

// 2026-09-18, round 14 (sandbox option table vs the real game). Real bounds
// bytecode-confirmed against D:/pz-verify/server/java/projectzomboid.jar's
// zombie.SandboxOptions constructor (javap -p -c -constants):
//   newIntegerOption("MaximumRatIndex", 0, 50, 25)
//   newIntegerOption("DaysUntilMaximumRatIndex", 0, 365, 90)
// SANDBOX_SCHEMA's own MaximumRatIndex.max used to be 100 (real: 50) --
// looser than the game, so a value our own validator accepted and saved
// (e.g. 75) would be rejected by B42's real sandbox loader. Same round,
// DaysUntilMaximumRatIndex.min used to be 1 (real: 0, a legal value) and
// .max used to be 3650 (real: 365) -- wrong in both directions at once.

function ratIndexSetting() {
  const setting = SANDBOX_SCHEMA.find((s) => s.key === 'MaximumRatIndex')
  if (!setting) throw new Error('MaximumRatIndex missing from SANDBOX_SCHEMA')
  return setting
}

function daysUntilSetting() {
  const setting = SANDBOX_SCHEMA.find((s) => s.key === 'DaysUntilMaximumRatIndex')
  if (!setting) throw new Error('DaysUntilMaximumRatIndex missing from SANDBOX_SCHEMA')
  return setting
}

describe('SANDBOX_SCHEMA: MaximumRatIndex / DaysUntilMaximumRatIndex match the real B42 bounds', () => {
  it('MaximumRatIndex matches the jar-confirmed bounds (min 0, max 50)', () => {
    expect(ratIndexSetting()).toMatchObject({ min: 0, max: 50, default: 25 })
  })

  it('a value above the real max no longer validates as in-range (used to pass at up to 100)', () => {
    const { min, max } = ratIndexSetting()
    expect(parseNumericSettingValue('75', { min, max })).toBeNull()
    expect(parseNumericSettingValue('50', { min, max })).toBe(50)
  })

  it('DaysUntilMaximumRatIndex matches the jar-confirmed bounds (min 0, max 365)', () => {
    expect(daysUntilSetting()).toMatchObject({ min: 0, max: 365, default: 90 })
  })

  it('0 is a real, accepted value for DaysUntilMaximumRatIndex (used to be rejected by our own too-tight min of 1)', () => {
    const { min, max } = daysUntilSetting()
    expect(parseNumericSettingValue('0', { min, max })).toBe(0)
  })

  it('a value above the real max no longer validates as in-range (used to pass at up to 3650)', () => {
    const { min, max } = daysUntilSetting()
    expect(parseNumericSettingValue('1000', { min, max })).toBeNull()
    expect(parseNumericSettingValue('365', { min, max })).toBe(365)
  })
})
