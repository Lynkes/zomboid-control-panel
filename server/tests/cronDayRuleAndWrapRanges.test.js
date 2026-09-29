import { afterEach, describe, expect, it, vi } from "vitest";
import cron from "node-cron";
import {
  computeNextRun,
  nodeCronNextRun,
  restrictsBothDayFields,
} from "../utils/cronNextRun.js";
import { expandCronField, isCronTooFrequent } from "../utils/cronValidation.js";

// 1.4.0 pre-release bug round (backups): two ways the panel's own cron
// reading disagreed with node-cron, the engine that actually fires every job.
//
// 1. Day rule. node-cron 4 requires the month, day-of-month AND day-of-week
//    to match (TimeMatcher.match ANDs them). computeNextRun applied classic
//    cron's "day-of-month OR weekday" rule, and the Backups page's live
//    preview showed its answer as "Next backup": "0 4 1 * 1" read as the next
//    1st of the month while node-cron first ran it on 2027-02-01.
// 2. Wrap-around ranges. node-cron expands "22-2" in the hour field to
//    22,23,0,1,2; the panel's expander refused start > end, and
//    isCronTooFrequent() reads "can't expand" as "too frequent" -- so
//    "0 22-2 * * *" (hourly) was refused as "more often than every 5
//    minutes".

const FROM = new Date("2026-09-28T12:00:00Z"); // a Monday

afterEach(() => {
  vi.useRealTimers();
});

// node-cron's own answer, as of FROM.
function nodeCronFrom(expression, timezone) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROM);
  try {
    return nodeCronNextRun(expression, timezone);
  } finally {
    vi.useRealTimers();
  }
}

describe("computeNextRun uses node-cron's day rule (both day fields must match)", () => {
  it.each([
    // [expression, what node-cron fires first]
    ["0 4 1 * 1", "2027-02-01T04:00:00.000Z"], // a 1st that is a Monday
    ["0 4 1-7 * 1", "2026-10-05T04:00:00.000Z"], // first Monday of the month
    ["0 4 13 * 5", "2026-11-13T04:00:00.000Z"], // Friday the 13th
  ])("%s -> %s", (expression, expected) => {
    expect(computeNextRun(expression, "UTC", FROM)).toBe(expected);
    expect(nodeCronFrom(expression, "UTC")).toBe(expected);
  });

  it("finds a run years away instead of giving up after a year", () => {
    // A Feb 29 that is a Monday: 2016, then 2044.
    expect(computeNextRun("0 4 29 2 1", "UTC", FROM)).toBe("2044-02-29T04:00:00.000Z");
  });

  it.each([
    "*/5 * * * *",
    "0 3 * * *",
    "30 4 * * 0",
    "0 0 1 * *",
    "0 4 1 * 1",
    "0 4 1-7 * 1",
    "15 2 10-20 * 2,4",
    "0 22-2 * * *",
    "0 22-2/2 * * 5-1",
    "0 4 28-3 * *",
    "30 3 * 11-2 *",
    "0 */6 * * *",
  ])("agrees with node-cron itself: %s (UTC and America/New_York)", (expression) => {
    for (const zone of ["UTC", "America/New_York"]) {
      expect(computeNextRun(expression, zone, FROM)).toBe(nodeCronFrom(expression, zone));
    }
  });
});

describe("nodeCronNextRun (the Backups preview's next run)", () => {
  it("covers node-cron syntax the panel's own expanders don't (names, L, nth weekday)", () => {
    expect(nodeCronFrom("0 4 * * MON", "UTC")).toBe("2026-10-05T04:00:00.000Z");
    expect(nodeCronFrom("0 4 L * *", "UTC")).toBe("2026-09-30T04:00:00.000Z");
    expect(nodeCronFrom("0 4 * * 1#1", "UTC")).toBe("2026-10-05T04:00:00.000Z");
  });

  it("leaves nothing in node-cron's task registry, and answers null for an unusable expression or zone", () => {
    const before = cron.getTasks().size;
    expect(nodeCronNextRun("0 4 * * *", "UTC")).toEqual(expect.any(String));
    expect(nodeCronNextRun("not cron", "UTC")).toBeNull();
    expect(nodeCronNextRun("0 4 * * *", "Not/AZone")).toBeNull();
    expect(cron.getTasks().size).toBe(before);
  });
});

describe("restrictsBothDayFields", () => {
  it.each([
    ["0 4 1 * 1", true],
    ["0 4 1-7 * MON", true],
    ["0 4 L * 5", true],
    ["0 4 * * 1", false],
    ["0 4 1 * *", false],
    ["0 4 1 * ?", false],
    ["0 4 1 * 0-7", false], // 7 is Sunday again: every weekday
    ["0 4 1-31 * 1", false], // every day of the month
    ["not cron", false],
  ])("%s -> %s", (expression, expected) => {
    expect(restrictsBothDayFields(expression)).toBe(expected);
  });
});

describe("wrap-around ranges expand the way node-cron expands them", () => {
  it("isCronTooFrequent judges a wrapping hour range by its real spacing", () => {
    expect(isCronTooFrequent("0 22-2 * * *")).toBe(false); // hourly, 22:00-02:00
    expect(isCronTooFrequent("0 23-0 * * *")).toBe(false);
    expect(isCronTooFrequent("*/5 22-2 * * *")).toBe(false); // every 5 min is allowed
    // ...and still refuses one that really is too frequent.
    expect(isCronTooFrequent("50-2 * * * *")).toBe(true); // every minute :50-:02
    expect(isCronTooFrequent("58-2/4 * * * *")).toBe(true); // :58 then :02
  });

  // Every field shape against node-cron's own expansion (cron.parse).
  const FIELDS = [
    // [position in cron.parse, min, max, field values to try]
    ["minute", 0, 59, ["*", "*/7", "5", "5,10", "10-20", "50-10", "50-10/4", "58-2/4", "0-59/15", "59-0"]],
    ["hour", 0, 23, ["*", "*/6", "22-2", "22-2/2", "23-0", "3-3", "1,22-1", "20-4/3"]],
    ["dayOfMonth", 1, 31, ["*", "1", "28-3", "30-2/2", "1-7", "*/10", "31-1"]],
    ["month", 1, 12, ["*", "11-2", "12-1", "3-9/2", "10-4/3"]],
    ["dayOfWeek", 0, 6, ["*", "5-1", "6-0", "1-5", "4-2/2", "0-6"]],
  ];
  const POSITION = { minute: 0, hour: 1, dayOfMonth: 2, month: 3, dayOfWeek: 4 };

  it.each(FIELDS)("%s field", (name, min, max, values) => {
    for (const value of values) {
      const fields = ["0", "0", "*", "*", "*"];
      fields[POSITION[name]] = value;
      const expression = fields.join(" ");
      expect(cron.validate(expression), expression).toBe(true);
      const expected = [...new Set(cron.parse(expression)[name])].sort((a, b) => a - b);
      const actual = [...expandCronField(value, max, min)].sort((a, b) => a - b);
      expect(actual, expression).toEqual(expected);
    }
  });

  it("still refuses out-of-bounds values", () => {
    expect(expandCronField("25-2", 23)).toBeNull();
    expect(expandCronField("22-24", 23)).toBeNull();
    expect(expandCronField("0-5", 31, 1)).toBeNull();
    expect(expandCronField("22-2/0", 23)).toBeNull();
  });
});
