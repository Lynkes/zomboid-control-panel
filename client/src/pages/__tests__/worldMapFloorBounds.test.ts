import { describe, expect, it } from "vitest";
import { FLOOR_MIN, FLOOR_MAX, clampFloor } from "../worldMapFloorBounds";

// continuous-bug-hunt round 26 (god's own catch, added to the PanelBridge
// round): the Floor Up button's `disabled={floor >= 29}` and changeFloor's
// own clamp (`Math.max(-1, Math.min(7, newFloor))`) were two independent
// literals meant to describe the same real B42 floor range, -1..7. They
// drifted apart -- Floor Up stayed clickable at floor 7, and every extra
// click fired a no-op changeFloor(8) (silently re-clamped to 7) that still
// cleared the tile cache and reset the failure/backoff state for nothing.
// Floor Down's own `floor <= -1` bound happened to already match the clamp.
// worldMapFloorBounds.ts pulls both into one shared source of truth so the
// button and the clamp read the exact same constants and can't diverge
// again -- these tests pin the constants' real values and clampFloor's
// actual clamping behavior at and past both ends.

describe("worldMapFloorBounds", () => {
  it("FLOOR_MAX is 7, the real B42 ceiling -- not the stale 29 the Floor Up button used to check against", () => {
    expect(FLOOR_MAX).toBe(7);
  });

  it("FLOOR_MIN is -1, the real B42 floor", () => {
    expect(FLOOR_MIN).toBe(-1);
  });

  it("clampFloor leaves an in-range value untouched", () => {
    expect(clampFloor(0)).toBe(0);
    expect(clampFloor(3)).toBe(3);
    expect(clampFloor(-1)).toBe(-1);
    expect(clampFloor(7)).toBe(7);
  });

  it("clampFloor caps a value above FLOOR_MAX down to FLOOR_MAX -- the exact no-op changeFloor(8) the bug let Floor Up keep firing", () => {
    expect(clampFloor(8)).toBe(FLOOR_MAX);
    expect(clampFloor(29)).toBe(FLOOR_MAX);
  });

  it("clampFloor floors a value below FLOOR_MIN up to FLOOR_MIN", () => {
    expect(clampFloor(-2)).toBe(FLOOR_MIN);
    expect(clampFloor(-100)).toBe(FLOOR_MIN);
  });
});
