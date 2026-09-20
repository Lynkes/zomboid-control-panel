import { describe, expect, it } from 'vitest'
import {
  percentToBridgeRainIntensity,
  percentToRconFraction,
  percentToUnitInterval,
} from '../weatherUnits'

describe('weather command unit conversions', () => {
  it('normalizes PanelBridge climate values once to 0-1', () => {
    expect(percentToUnitInterval(0)).toBe(0)
    expect(percentToUnitInterval(50)).toBe(0.5)
    expect(percentToUnitInterval(100)).toBe(1)
  })

  it('keeps the bridge rain minimum at 5% without changing the unit', () => {
    expect(percentToBridgeRainIntensity(1)).toBe(0.05)
    expect(percentToBridgeRainIntensity(50)).toBe(0.5)
    expect(percentToBridgeRainIntensity(100)).toBe(1)
  })

  it('normalizes the percentage once for the RCON adapter contract', () => {
    expect(percentToRconFraction(1)).toBe(0.01)
    expect(percentToRconFraction(50)).toBe(0.5)
    expect(percentToRconFraction(100)).toBe(1)
    expect(percentToRconFraction(50.6)).toBe(0.506)
  })
})
