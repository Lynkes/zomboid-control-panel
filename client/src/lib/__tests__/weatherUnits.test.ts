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

describe('percentOfRange', () => {
  it('shows the view distance (0..100 in the game, scaled x100 by the slider) as a percent of its range', async () => {
    const { percentOfRange, sliderStepForRange } = await import('../weatherUnits')
    expect(percentOfRange(8354, { min: 0, max: 10000 })).toBe(84)
    expect(percentOfRange(50, { min: 0, max: 100 })).toBe(50)
    expect(percentOfRange(150, { min: 100, max: 200 })).toBe(50)
    expect(percentOfRange(42, { min: 0, max: 0 })).toBe(42)
    expect(sliderStepForRange({ min: 0, max: 10000 })).toBe(500)
    expect(sliderStepForRange({ min: 0, max: 100 })).toBe(5)
  })
})
