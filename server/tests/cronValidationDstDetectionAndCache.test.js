import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDstCachesForTests,
  dstFallBackWarning,
  dstSpringForwardWarning,
  timezoneObservesDst,
} from "../utils/cronValidation.js";

// Two defects in the DST warnings' plumbing:
//
// 1. timezoneObservesDst() compared one January and one July of 2026, so a
//    zone whose clocks change only for a few weeks read as DST-free.
//    Africa/Casablanca (+01 all year except about 30 days around Ramadan, when
//    it is +00) has the same offset on both dates, so none of its DST
//    warnings were ever shown. It now samples weekly from now to two years
//    ahead.
// 2. dstSpringForwardWarning() scans a year of days with Intl on every call
//    (~120 ms for one fire time, ~800 ms for eight) and every scheduleTask(),
//    boot and timezone change repeats it per task. The Intl formatters are now
//    reused and the answer is cached per zone and fire times for the day.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
  _resetDstCachesForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timezoneObservesDst() sees zones whose DST is not in January or July", () => {
  it("Africa/Casablanca (Ramadan DST) observes DST, whatever the date it is asked on", () => {
    for (const asked of ["2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z", "2026-10-10T12:00:00Z", "2027-05-20T00:00:00Z"]) {
      vi.setSystemTime(new Date(asked));
      _resetDstCachesForTests();
      expect(timezoneObservesDst("Africa/Casablanca")).toBe(true);
    }
  });

  it("still true for ordinary DST zones and false for zones with a fixed offset", () => {
    expect(timezoneObservesDst("America/New_York")).toBe(true);
    expect(timezoneObservesDst("Europe/London")).toBe(true);
    expect(timezoneObservesDst("Australia/Sydney")).toBe(true);
    for (const zone of ["UTC", "Asia/Tokyo", "America/Phoenix", "Asia/Kolkata", "Africa/Lagos"]) {
      expect(timezoneObservesDst(zone)).toBe(false);
    }
  });

  it("is false (not a throw) for a name Intl rejects", () => {
    expect(timezoneObservesDst("Not/AZone")).toBe(false);
  });

  it("the DST warnings that gate on it now fire for Casablanca", () => {
    expect(dstFallBackWarning("*/15 * * * *", "Africa/Casablanca", "Ping")).toContain("Africa/Casablanca");
    const warning = dstSpringForwardWarning("30 2 * * *", "Africa/Casablanca", "Nightly");
    expect(warning).toContain('"Nightly"');
    expect(warning).toContain("Africa/Casablanca");
    expect(warning).toContain("springs forward");
    expect(warning).toMatch(/on 20(26|27)-\d{2}-\d{2}, /);
  });
});

// Counts Intl.DateTimeFormat constructions, the expensive step.
function countConstructions() {
  const Real = Intl.DateTimeFormat;
  const counter = { count: 0 };
  Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      counter.count += 1;
      return new target(...args);
    },
  });
  counter.restore = () => {
    Intl.DateTimeFormat = Real;
  };
  return counter;
}

describe("dstSpringForwardWarning() is cached", () => {
  let counter;
  afterEach(() => counter?.restore());

  it("the second call for the same zone and fire time builds nothing, and keeps its own label", () => {
    counter = countConstructions();
    const first = dstSpringForwardWarning("30 2 * * *", "America/New_York", "Nightly backup");
    expect(first).toContain('"Nightly backup"');
    expect(first).toContain("2027-03-14");
    const afterFirst = counter.count;
    expect(afterFirst).toBeGreaterThan(0);

    const second = dstSpringForwardWarning("30 2 * * *", "America/New_York", "Auto restart");
    expect(counter.count).toBe(afterFirst);
    expect(second).toBe(first.replace('"Nightly backup"', '"Auto restart"'));
  });

  it("a boot or timezone-change loop over many tasks with the same schedule scans once", () => {
    counter = countConstructions();
    dstSpringForwardWarning("0 4 * * *", "America/New_York", "t0");
    const afterFirst = counter.count;
    for (let i = 1; i < 40; i += 1) {
      expect(dstSpringForwardWarning("0 4 * * *", "America/New_York", `t${i}`)).toBeNull();
    }
    expect(counter.count).toBe(afterFirst);
  });

  it("the Intl formatters are reused across a scan -- not one per day and fire time", () => {
    counter = countConstructions();
    dstSpringForwardWarning("0,30 5-8 * * *", "America/New_York", "eight times"); // 8 fire times x ~370 days
    expect(counter.count).toBeLessThan(10);
  });

  it("different fire times in the same zone do not share an answer", () => {
    expect(dstSpringForwardWarning("30 2 * * *", "America/New_York", "a")).toContain("02:30");
    expect(dstSpringForwardWarning("0 4 * * *", "America/New_York", "a")).toBeNull();
    expect(dstSpringForwardWarning("30 2 * * *", "America/New_York", "a")).toContain("02:30");
  });

  it("different zones do not share an answer", () => {
    expect(dstSpringForwardWarning("30 1 * * *", "Europe/London", "a")).toContain("Europe/London");
    expect(dstSpringForwardWarning("30 1 * * *", "America/New_York", "a")).toBeNull();
    expect(dstSpringForwardWarning("30 1 * * *", "UTC", "a")).toBeNull();
  });

  it("a new day recomputes: a transition that has passed is not reported again", () => {
    vi.setSystemTime(new Date("2027-03-10T12:00:00Z"));
    expect(dstSpringForwardWarning("30 2 * * *", "America/New_York", "a")).toContain("2027-03-14");

    vi.setSystemTime(new Date("2027-03-15T12:00:00Z"));
    const later = dstSpringForwardWarning("30 2 * * *", "America/New_York", "a");
    expect(later).toContain("2028-03-12");
    expect(later).not.toContain("2027-03-14");
  });

  it("the answer is the same as with a cold cache", () => {
    const warm = dstSpringForwardWarning("30 2 * * *", "Europe/London", "x");
    expect(dstSpringForwardWarning("30 2 * * *", "Europe/London", "x")).toBe(warm);
    _resetDstCachesForTests();
    expect(dstSpringForwardWarning("30 2 * * *", "Europe/London", "x")).toBe(warm);
  });
});

describe("timezoneObservesDst() is cached too", () => {
  it("the second ask for a zone builds nothing", () => {
    const counter = countConstructions();
    try {
      timezoneObservesDst("Europe/Paris");
      const afterFirst = counter.count;
      expect(afterFirst).toBeGreaterThan(0);
      for (let i = 0; i < 20; i += 1) timezoneObservesDst("Europe/Paris");
      expect(counter.count).toBe(afterFirst);
    } finally {
      counter.restore();
    }
  });
});
