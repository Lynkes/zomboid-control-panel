import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { dstSpringForwardWarning } from "../utils/cronValidation.js";
import { Scheduler } from "../services/scheduler.js";

// continuous-bug-hunt round 17 (2026-09-18, scheduler DST sweep): the
// existing dstFallBackWarning() only covers a sub-hourly schedule's
// fall-back risk. A schedule with a SINGLE fixed hour:minute -- the common
// shape for a nightly backup or restart -- was believed entirely DST-safe
// (correctly, for fall-back: node-cron's matcher can't re-fire the same
// hour:minute twice on one calendar day). But nothing checked
// SPRING-FORWARD: a fixed time that falls inside the skipped local hour is
// silently dropped for that one day, with no missed-execution event (there
// was never a valid slot to miss) and no warning. Verified empirically
// against real node-cron 4.6.0 (server/services rounds' own comment cites
// this file's own reasoning) before writing this fix: cron.schedule("30 2
// * * *", ..., { timezone: "America/New_York" }) skips 2026-03-08 (the
// real US spring-forward date that year) entirely, going straight from
// 2026-03-07 02:30 EST to 2026-03-09 02:30 EDT.
//
// System time is pinned so these tests don't depend on when they're run --
// dstSpringForwardWarning() scans forward from "now" for the next
// transition within its scan window.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dstSpringForwardWarning()", () => {
  it("warns for a fixed daily time that falls inside the spring-forward gap, naming the label, time, date, and zone", () => {
    const warning = dstSpringForwardWarning(
      "30 2 * * *",
      "America/New_York",
      "Nightly backup",
    );
    expect(warning).toContain("Nightly backup");
    expect(warning).toContain("02:30");
    expect(warning).toContain("2026-03-08");
    expect(warning).toContain("America/New_York");
    expect(warning).toContain("node-cron");
  });

  it("is null for a fixed daily time nowhere near the transition", () => {
    expect(
      dstSpringForwardWarning("0 12 * * *", "America/New_York", "Noon job"),
    ).toBeNull();
  });

  it("is null in a zone with no DST, even for the same at-risk time", () => {
    expect(dstSpringForwardWarning("30 2 * * *", "UTC", "x")).toBeNull();
  });

  it("is null for a malformed expression", () => {
    expect(
      dstSpringForwardWarning("not a cron", "America/New_York", "x"),
    ).toBeNull();
  });

  it("works with no label (auto-restart / backup callers don't pass a task name)", () => {
    const warning = dstSpringForwardWarning("30 2 * * *", "America/New_York");
    expect(warning).not.toContain('""');
    expect(warning).toContain("02:30");
  });

  it("does not warn for a genuinely sub-hourly schedule (too many fire combinations to scan cheaply; dstFallBackWarning already covers that shape)", () => {
    expect(
      dstSpringForwardWarning("*/15 * * * *", "America/New_York", "Frequent"),
    ).toBeNull();
  });

  it("finds a DIFFERENT zone's own transition date, not America/New_York's -- proves the scan is zone-specific, not hardcoded", () => {
    // Europe/London's 2026 spring-forward is 2026-03-29 (last Sunday of
    // March), not 2026-03-08.
    const warning = dstSpringForwardWarning(
      "30 1 * * *",
      "Europe/London",
      "London nightly",
    );
    expect(warning).toContain("Europe/London");
    expect(warning).toContain("2026-03-29");
    expect(warning).not.toContain("2026-03-08");
  });
});

describe("Scheduler.scheduleTask() -- surfaces the spring-forward warning too, not just fall-back", () => {
  let scheduler;

  afterEach(() => {
    for (const job of scheduler?.jobs?.values() || []) job.stop();
  });

  it("returns a non-null dstWarning for a fixed-time task that falls in the spring-forward gap", () => {
    scheduler = new Scheduler(null, null);
    scheduler.effectiveTimezone = "America/New_York";
    const result = scheduler.scheduleTask({
      id: "t1",
      name: "Nightly restart",
      cron_expression: "30 2 * * *",
    });
    expect(result.scheduled).toBe(true);
    expect(result.dstWarning).toContain("Nightly restart");
    expect(result.dstWarning).toContain("springs forward");
  });

  it("returns a null dstWarning for the same fixed time in a zone with no DST", () => {
    scheduler = new Scheduler(null, null);
    scheduler.effectiveTimezone = "UTC";
    const result = scheduler.scheduleTask({
      id: "t2",
      name: "Nightly restart UTC",
      cron_expression: "30 2 * * *",
    });
    expect(result.dstWarning).toBeNull();
  });
});
