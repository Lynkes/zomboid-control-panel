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
  it("flags the reported collision: both every 4 hours on the hour", () => {
    expect(find("0 */4 * * *", [task("0 */4 * * *", "Restart every 4h")])).toEqual([
      { kind: "task", name: "Restart every 4h", cron: "0 */4 * * *", restartTime: "00:00", backupTime: "00:00" },
    ]);
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
