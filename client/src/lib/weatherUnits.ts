export function percentToUnitInterval(percent: number): number {
  return Math.max(0, Math.min(1, percent / 100))
}

export function percentToBridgeRainIntensity(percent: number): number {
  return Math.max(0.05, percentToUnitInterval(percent))
}

export function percentToRconFraction(percent: number): number {
  return percentToUnitInterval(percent)
}

/**
 * Where a slider value sits in its range, as a whole percent. Some climate
 * floats are not 0..1 (the game's view distance runs 0..100), so showing the
 * raw value times 100 read as "8354%".
 */
export function percentOfRange(value: number, range: { min: number; max: number }): number {
  const span = range.max - range.min
  if (!(span > 0)) return Math.round(value)
  return Math.round(Math.min(100, Math.max(0, ((value - range.min) / span) * 100)))
}

/** A slider step of 5% of its range (at least 1). */
export function sliderStepForRange(range: { min: number; max: number }): number {
  return Math.max(1, Math.round((range.max - range.min) / 20))
}
