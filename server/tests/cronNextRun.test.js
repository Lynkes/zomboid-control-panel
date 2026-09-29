import { describe, expect, it } from "vitest";
import { computeNextRun } from "../utils/cronNextRun.js";

// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): the UX
// deep pass (092bfac0) wanted a per-task "next run" time on Scheduler but
// had no server data to compute it from -- node-cron itself has no "what
// time does this fire next" API. computeNextRun fills that gap, reusing
// cronValidation.js's own timezone-resolution primitives so it can't
// disagree with that file's DST-warning checks about what a given
// expression + timezone combination means.

describe("computeNextRun", () => {
  const FROM = new Date("2026-09-18T13:02:00Z"); // a Friday

  it("finds the next 5-minute boundary in UTC", () => {
    expect(computeNextRun("*/5 * * * *", "UTC", FROM)).toBe("2026-09-18T13:05:00.000Z");
  });

  it("never returns a time at or before `from`, even when from lands exactly on a boundary", () => {
    const onBoundary = new Date("2026-09-18T13:05:00Z");
    expect(computeNextRun("*/5 * * * *", "UTC", onBoundary)).toBe("2026-09-18T13:10:00.000Z");
  });

  it("resolves a daily time correctly across a real UTC offset (America/New_York, EDT in September)", () => {
    // 3am EDT (UTC-4 in September) = 07:00 UTC. `from` is already past 3am
    // local today, so the next occurrence is tomorrow.
    expect(computeNextRun("0 3 * * *", "America/New_York", FROM)).toBe(
      "2026-09-19T07:00:00.000Z",
    );
  });

  it("finds the next matching day-of-week (weekly schedule)", () => {
    // Friday 2026-09-18 -> next Sunday is 2026-09-20.
    expect(computeNextRun("30 4 * * 0", "UTC", FROM)).toBe("2026-09-20T04:30:00.000Z");
  });

  it("finds the next matching day-of-month (monthly schedule)", () => {
    expect(computeNextRun("0 0 1 * *", "UTC", FROM)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("requires day-of-month AND day-of-week when both are restricted -- node-cron's rule, not classic cron's OR", () => {
    // node-cron 4 (which fires every job) ANDs the two day fields: "the
    // 15th, when it is a Monday" -- 2027-02-15, not the Monday 2026-09-21
    // classic cron's "15th or Monday" would give.
    expect(computeNextRun("0 9 15 * 1", "UTC", FROM)).toBe("2027-02-15T09:00:00.000Z");
  });

  it("returns null for an unsupported field count", () => {
    expect(computeNextRun("* * * *", "UTC", FROM)).toBeNull();
  });

  it("returns null (bounded search) for a calendar-impossible expression instead of hanging", () => {
    expect(computeNextRun("0 0 30 2 *", "UTC", FROM)).toBeNull();
  });

  it("returns null for a malformed field (non-numeric, non-wildcard)", () => {
    expect(computeNextRun("x * * * *", "UTC", FROM)).toBeNull();
  });
});
