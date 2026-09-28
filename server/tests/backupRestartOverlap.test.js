import { describe, expect, it } from "vitest";
import { findBackupRestartOverlaps } from "../utils/backupRestartOverlap.js";

// Pure prediction behind the Backups/Scheduler pages' "backups overlap a
// scheduled restart" notice: from the two cron expressions alone, does the
// backup schedule fire while a scheduled restart would still be running
// (at the restart's minute, or within `windowMinutes` of it)? Both run in
// the same scheduler timezone, so this compares local wall-clock times.

const FROM = new Date("2026-09-27T12:00:00.000Z"); // a Sunday
const task = (cron, name = "Restart") => ({ kind: "task", name, cron });
const find = (backupCron, restarts, windowMinutes = 10) =>
  findBackupRestartOverlaps(backupCron, restarts, { timezone: "UTC", windowMinutes, from: FROM });

describe("findBackupRestartOverlaps", () => {
  it("flags the reported collision: both every 4 hours on the hour -- and says it is EVERY backup", () => {
    expect(find("0 */4 * * *", [task("0 */4 * * *", "Restart every 4h")])).toEqual([
      {
        kind: "task",
        name: "Restart every 4h",
        cron: "0 */4 * * *",
        restartTime: "00:00",
        backupTime: "00:00",
        timezone: "UTC",
        allBackups: true,
        windowMinutes: 10,
      },
    ]);
  });

  it("says which timezone its example times are in -- the scheduler's, falling back to UTC like the times themselves", () => {
    // 04:00 in New York is 08:00 UTC: the times are local to that zone,
    // and the zone travels with them so a page can label them.
    const newYork = findBackupRestartOverlaps("0 4 * * *", [task("0 4 * * *")], {
      timezone: "America/New_York", windowMinutes: 10, from: FROM,
    });
    expect(newYork).toEqual([
      expect.objectContaining({ restartTime: "04:00", backupTime: "04:00", timezone: "America/New_York" }),
    ]);
    const unknown = findBackupRestartOverlaps("0 4 * * *", [task("0 4 * * *")], {
      timezone: "Not/A_Zone", windowMinutes: 10, from: FROM,
    });
    expect(unknown).toEqual([expect.objectContaining({ timezone: "UTC" })]);
  });

  it("says SOME backups when only part of the schedule collides", () => {
    // Backups at 00/06/12/18 against restarts at 00/04/08/12/16/20: the
    // 00:00 and 12:00 backups collide, the 06:00 and 18:00 ones don't.
    expect(find("0 */6 * * *", [task("0 */4 * * *")])).toEqual([
      expect.objectContaining({ restartTime: "00:00", backupTime: "00:00", allBackups: false }),
    ]);
    // Every 15 minutes against a daily 04:00 restart: one backup a day.
    expect(find("*/15 * * * *", [task("0 4 * * *")])).toEqual([
      expect.objectContaining({ restartTime: "04:00", backupTime: "04:00", allBackups: false }),
    ]);
  });

  it("counts a backup covered by the previous day's restart window as colliding", () => {
    // Restart 23:55 daily, backup 00:02 daily: every backup falls in the
    // window that started the evening before.
    expect(find("2 0 * * *", [task("55 23 * * *")])).toEqual([
      expect.objectContaining({ allBackups: true }),
    ]);
  });

  it("stays quiet when the backup never leaves a restart-window-sized gap -- no staggering could avoid it, and the held run is no later than the next tick", () => {
    expect(find("*/5 * * * *", [task("0 */4 * * *")])).toEqual([]);
    expect(find("*/10 * * * *", [task("0 */4 * * *")])).toEqual([]);
    // Runs further apart than the window: staggering CAN avoid it (a
    // restart at :05 against backups at :00/:15/:30/:45), so it warns.
    expect(find("*/15 * * * *", [task("0 */4 * * *")])).toHaveLength(1);
  });

  it("flags a backup a few minutes into the restart's window, not one after it", () => {
    expect(find("5 4 * * *", [task("0 4 * * *")])).toEqual([
      expect.objectContaining({ restartTime: "04:00", backupTime: "04:05" }),
    ]);
    expect(find("15 4 * * *", [task("0 4 * * *")])).toEqual([]);
  });

  it("ignores a backup just BEFORE the restart -- it starts first and is not held back", () => {
    expect(find("55 3 * * *", [task("0 4 * * *")])).toEqual([]);
  });

  it("follows the window across midnight into the next day's backup", () => {
    expect(find("2 0 * * *", [task("55 23 * * *")])).toEqual([
      expect.objectContaining({ restartTime: "23:55", backupTime: "00:02" }),
    ]);
  });

  it("respects day-of-week: a Sunday restart does not collide with a weekday-only backup", () => {
    expect(find("0 4 * * 1-5", [task("0 4 * * 0")])).toEqual([]);
    expect(find("0 4 * * *", [task("0 4 * * 0")])).toEqual([
      expect.objectContaining({ restartTime: "04:00", backupTime: "04:00" }),
    ]);
  });

  it("finds a collision that only happens on a specific day of the month", () => {
    expect(find("0 4 1 * *", [task("0 4 * * 3")])).toEqual([
      expect.objectContaining({ restartTime: "04:00", backupTime: "04:00" }),
    ]);
  });

  it("follows node-cron's day rule when both day fields are restricted: the 1st of the month AND a Monday, not either", () => {
    // node-cron 4.x ANDs day-of-month and day-of-week (TimeMatcher.match),
    // so this backup only ever fires on a Monday the 1st -- never on a
    // Tuesday, when the restart runs. Under the classic cron OR rule it
    // would also fire on every 1st, and a Tuesday the 1st would collide.
    expect(find("0 4 1 * 1", [task("0 4 * * 2")])).toEqual([]);
    // Same backup against a Monday restart: it does collide, on those days.
    expect(find("0 4 1 * 1", [task("0 4 * * 1")])).toEqual([
      expect.objectContaining({ restartTime: "04:00", backupTime: "04:00", allBackups: true }),
    ]);
  });

  it("reports each overlapping restart schedule once, and skips ones it can't parse", () => {
    const overlaps = find("0 */6 * * *", [
      task("0 */6 * * *", "A"),
      task("30 */6 * * *", "B"),
      task("0 4 * * MON", "named weekday -- not parsed, no warning"),
      { kind: "autoRestart", name: null, cron: "0 0 * * *" },
    ]);
    expect(overlaps.map((o) => o.name ?? o.kind)).toEqual(["A", "autoRestart"]);
  });

  it("returns nothing for an unparseable backup schedule or no restarts at all", () => {
    expect(find("not a cron", [task("0 4 * * *")])).toEqual([]);
    expect(find("0 4 * * *", [])).toEqual([]);
  });
});
