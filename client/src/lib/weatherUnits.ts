export function percentToUnitInterval(percent: number): number {
  return Math.max(0, Math.min(1, percent / 100))
}

export function percentToBridgeRainIntensity(percent: number): number {
  return Math.max(0.05, percentToUnitInterval(percent))
}

export function percentToRconFraction(percent: number): number {
  return percentToUnitInterval(percent)
}
