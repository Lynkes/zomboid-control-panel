import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// continuous-bug-hunt round 17 (scheduler overlap sweep, 2026-09-18): every
// OTHER refusal Scheduler can produce already writes a Schedule History
// entry -- a busy lifecycle lock and a genuine execution failure deep
// inside performRestart() both call logScheduleExecution() themselves; the
// scheduled backup's own restart-overlap skip logs (setupBackupSchedule(),
// see linuxSchedulerBackupRestartOverlap.test.js); runTaskNow()'s
// self-overlap refusal logs (see schedulerDuplicateRunSkipVisibility.test.js).
// The one exception was the auto-restart job's OWN cron tick landing while
// this.restartInProgress was ALREADY true (a manual restart, a scheduled
// task's own "restart" command, or a prior auto-restart tick still running)
// -- performRestart()'s very first guard returns {success:false} before
// ever touching Schedule History, and the cron callback only sent that to
// the server log (log.error), never logScheduleExecution(). An operator
// reading Schedule History after that tick saw nothing: indistinguishable
// from a healthy schedule with nothing due, for the exact tick that was
// actually skipped.

const logScheduleExecution = vi.fn().mockResolvedValue();

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(),
  getServer: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(),
}));

let capturedAutoRestartCallback = null;

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expression, callback) => {
      capturedAutoRestartCallback = callback;
      return {
        stop: vi.fn(),
        on: vi.fn(),
        getNextRun: () => null,
      };
    }),
    validate: vi.fn(() => true),
  },
}));

const { Scheduler } = await import("../services/scheduler.js");

describe("Scheduler: the auto-restart cron tick's own refusal is recorded, not silent", () => {
  let scheduler;
  let originalEnv;

  beforeEach(() => {
    capturedAutoRestartCallback = null;
    logScheduleExecution.mockClear();
    originalEnv = { ...process.env };
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 5 * * *";
    scheduler = new Scheduler({}, {});
    scheduler.effectiveTimezone = "UTC";
  });

  afterEach(() => {
    if (scheduler.autoRestartJob) scheduler.autoRestartJob.stop();
    process.env = originalEnv;
  });

  it("logs a false Schedule History entry when the tick lands while a restart is already in progress", async () => {
    scheduler.setupAutoRestart();
    expect(capturedAutoRestartCallback).toBeTypeOf("function");

    // Same simulation technique schedulerDuplicateRunSkipVisibility.test.js
    // uses for runTaskNow()'s identical guard: set the flag performRestart()
    // itself checks, rather than racing a real restart.
    scheduler.restartInProgress = true;

    await capturedAutoRestartCallback();

    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      "Restart already in progress",
      0,
    );
    // continuous-bug-hunt round 19 (duplicate Schedule History row):
    // performRestart()'s restartInProgress guard fires BEFORE it ever calls
    // logScheduleExecution itself, so this cron-callback call is the ONLY
    // one -- exactly one row, not zero (the original silent-refusal bug
    // this test file exists for) and not two.
    expect(logScheduleExecution).toHaveBeenCalledTimes(1);
  });

  it("logs a false Schedule History entry when the tick is refused by a busy lifecycle lock held by an unrelated operation", async () => {
    scheduler.setupAutoRestart();
    expect(capturedAutoRestartCallback).toBeTypeOf("function");

    const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");
    const heldLock = acquireLifecycleLock("wipe", "server-1");
    expect(heldLock).toBeTruthy();

    try {
      await capturedAutoRestartCallback();

      expect(logScheduleExecution).toHaveBeenCalledWith(
        null,
        "Auto Restart",
        "restart",
        false,
        expect.stringContaining("already in progress"),
        0,
      );
      // Same "exactly one row" reasoning as the restartInProgress case above
      // -- the lifecycle-lock guard also fires before performRestart() ever
      // logs anything itself.
      expect(logScheduleExecution).toHaveBeenCalledTimes(1);
    } finally {
      heldLock.release();
    }
  });

  it("positive control: does not log a refusal when the tick runs normally (no restart in progress, no lock held)", async () => {
    // performRestart() will fail deep inside for lack of a real
    // rconService/serverManager -- that's fine, this test only asserts NO
    // spurious "already in progress"-shaped entry is written for a clean
    // run; performRestart()'s own deep-failure logging (a different,
    // already-covered path) is not what this test is about.
    scheduler.setupAutoRestart();
    await capturedAutoRestartCallback();

    expect(logScheduleExecution).not.toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      "Restart already in progress",
      0,
    );
  });

  // continuous-bug-hunt round 19 (duplicate Schedule History row): bb389c83
  // (round 17) added the cron callback's own logScheduleExecution() call
  // unconditionally on `!result.success` -- but a genuine DEEP failure
  // inside performRestart() (RCON unreachable, process scan failed, ...)
  // already calls logScheduleExecution() itself before returning, several
  // hundred lines up. Logging again here meant a real restart failure wrote
  // TWO Schedule History rows for the one execution, not one -- the common
  // case, not an edge case. This is the same scenario the "positive
  // control" test above already sets up (an empty {} serverManager makes
  // performRestart() hit its process-scan-failed branch and return
  // {success:false, logged:true}) -- pinning the exact call COUNT here,
  // not just which args it was/wasn't called with.
  it("logs exactly ONE Schedule History row for a genuine deep failure inside performRestart, not two", async () => {
    scheduler.setupAutoRestart();
    await capturedAutoRestartCallback();

    expect(logScheduleExecution).toHaveBeenCalledTimes(1);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      expect.any(String),
      expect.any(Number),
    );
  });
});
