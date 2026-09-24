// continuous-bug-hunt round 26 (god's own catch, added to the PanelBridge
// round): the Floor Up button's own `disabled={floor >= 29}` and
// changeFloor's clamp (`Math.max(-1, Math.min(7, newFloor))`) were two
// independent literals meant to describe the same real range -- B42's floor
// range is -1..7, not -1..29. They drifted apart at some point, and nothing
// forced them to stay in sync: Floor Up stayed clickable at floor 7, and
// every extra click fired a no-op changeFloor(8) (silently clamped back to
// 7) that still cleared the tile cache and reset the failure/backoff state
// for no reason. Floor Down's own `floor <= -1` bound happened to already
// match the clamp correctly -- only Floor Up's had drifted.
//
// Pulled the bounds out into one shared source of truth so the button and
// the clamp can never diverge again, and so this is unit-testable without
// mounting the canvas -- same reasoning as worldMapConfigEqual.ts and
// worldMapTileFallback.ts.
export const FLOOR_MIN = -1
export const FLOOR_MAX = 7

export function clampFloor(floor: number): number {
  return Math.max(FLOOR_MIN, Math.min(FLOOR_MAX, floor))
}
