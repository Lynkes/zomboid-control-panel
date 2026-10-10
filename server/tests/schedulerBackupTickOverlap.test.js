import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Overlapping scheduled backup ticks logged false failures. Only a tick held
// back by a RESTART was folded into the earlier one; a tick that landed while
// a normal scheduled backup was still zipping (a big world, a short
// interval), or while a manual "Create Backup Now" was running, started a
// second createBackup(). That is refused with "Backup already in progress",
// which went into Schedule History as a failed scheduled backup and raised the
// Dashboard's "Scheduled backup failing" warning although every backup was
// fine.
//
// The fake backup service below keeps createBackup()'s real mutex contract
// (backupInProgress, and the same refusal message), so the old code's second
// call produces the false failure exactly as in the field.

const logScheduleExecution = vi.fn().mockResolvedValue();

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(),
  getServer: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn().mockResolvedValue({ handled: false }),
}));

let capturedBackupCallback = null;

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expression, callback) => {
      capturedBackupCallback = callback;
      return { stop: vi.fn(), getNextRun: () => null, on: vi.fn() };
    }),
    validate: vi.fn(() => true),
  },
}));

const { Scheduler } = await import("../services/scheduler.js");

const SETTLE = 5 * 1000; // SAME_SECOND_RESTART_SETTLE_MS
const MINUTE = 60 * 1000;
const backupRows = () =>
  logScheduleExecution.mock.calls.filter((call) => call[2] === "backup");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Scheduler: overlapping scheduled backup ticks", () => {
  let scheduler;
  let backupService;
  let runs; // one deferred per createBackup() call that ran

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T04:00:00.000Z"));
    capturedBackupCallback = null;
    logScheduleExecution.mockClear();
    runs = [];
    backupService = {
      backupInProgress: false,
      getSettings: vi.fn(async () => ({ enabled: true, schedule: "*/15 * * * *", includeDb: false })),
      // The real createBackup(): refuses while another backup holds the flag.
      createBackup: vi.fn(async () => {
        if (backupService.backupInProgress) {
          return { success: false, message: "Backup already in progress" };
        }
        backupService.backupInProgress = true;
        const run = deferred();
        runs.push(run);
        try {
          return await run.promise;
        } finally {
          backupService.backupInProgress = false;
        }
      }),
    };
    scheduler = new Scheduler({}, {});
    scheduler.setBackupService(backupService);
    await scheduler.setupBackupSchedule();
    expect(capturedBackupCallback).toBeTypeOf("function");
  });

  afterEach(() => {
    scheduler.stopAllJobs();
    vi.useRealTimers();
  });

  const ok = (name) => ({ success: true, backup: { name } });

  it("a tick that lands while the previous scheduled backup is still running folds into it -- one backup, one success row, no false failure", async () => {
    const first = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    expect(backupService.createBackup).toHaveBeenCalledTimes(1);

    // 15 minutes later the big backup is still zipping and the next tick fires.
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    const second = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    await second;
    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
    expect(backupRows()).toHaveLength(0);

    runs[0].resolve(ok("world_1.zip"));
    await first;

    const rows = backupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe(true);
    expect(rows[0][4]).toMatch(/^Created: world_1\.zip/);
    expect(scheduler.scheduledBackupTick).toBeNull();
  });

  it("the next tick after that run has ended runs normally (the fold does not outlive its backup)", async () => {
    const first = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    runs[0].resolve(ok("world_1.zip"));
    await first;

    const later = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    expect(backupService.createBackup).toHaveBeenCalledTimes(2);
    runs[1].resolve(ok("world_2.zip"));
    await later;

    expect(backupRows().map((row) => row[3])).toEqual([true, true]);
  });

  it("a manual backup already running: the scheduled tick is skipped quietly -- no createBackup, no Schedule History row", async () => {
    backupService.backupInProgress = true; // a manual "Create Backup Now" is zipping
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    await tick;

    expect(backupService.createBackup).not.toHaveBeenCalled();
    expect(backupRows()).toHaveLength(0);
    expect(scheduler.scheduledBackupTick).toBeNull();

    // Once the manual backup is over, the next tick backs up as usual.
    backupService.backupInProgress = false;
    const next = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    runs[0].resolve(ok("world_3.zip"));
    await next;
    expect(backupRows().map((row) => row[3])).toEqual([true]);
  });

  it("a backup held back by a restart is skipped quietly too when a manual backup is running by the time the restart ends", async () => {
    scheduler.restartInProgress = true;
    scheduler.activeRestart = { startedAt: Date.now(), warningMinutes: 5 };
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(MINUTE);

    backupService.backupInProgress = true;
    scheduler.restartInProgress = false;
    scheduler.activeRestart = null;
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(backupService.createBackup).not.toHaveBeenCalled();
    expect(backupRows()).toHaveLength(0);
    expect(scheduler.deferredBackup).toBeNull();
  });

  describe("a real failure still surfaces", () => {
    it("createBackup() reporting a failure is logged once as a failed scheduled backup", async () => {
      backupService.createBackup.mockResolvedValueOnce({ success: false, message: "ENOSPC: no space left on device" });
      const tick = capturedBackupCallback();
      await vi.advanceTimersByTimeAsync(SETTLE + 100);
      await tick;

      const rows = backupRows();
      expect(rows).toHaveLength(1);
      expect(rows[0][3]).toBe(false);
      expect(rows[0][4]).toBe("ENOSPC: no space left on device");
    });

    it("createBackup() throwing is logged as a failure, and the next tick is not swallowed by the dead one", async () => {
      backupService.createBackup.mockRejectedValueOnce(new Error("archive write failed"));
      const tick = capturedBackupCallback();
      await vi.advanceTimersByTimeAsync(SETTLE + 100);
      await tick;
      expect(backupRows()).toHaveLength(1);
      expect(backupRows()[0][3]).toBe(false);
      expect(backupRows()[0][4]).toMatch(/archive write failed/);

      const next = capturedBackupCallback();
      await vi.advanceTimersByTimeAsync(SETTLE + 100);
      runs[0].resolve(ok("world_4.zip"));
      await next;
      expect(backupRows().map((row) => row[3])).toEqual([false, true]);
    });

    it("a refusal that is NOT an overlap (a restore in progress) is still a logged failure", async () => {
      backupService.createBackup.mockResolvedValueOnce({ success: false, message: "Restore in progress, please wait" });
      const tick = capturedBackupCallback();
      await vi.advanceTimersByTimeAsync(SETTLE + 100);
      await tick;

      expect(backupRows()).toHaveLength(1);
      expect(backupRows()[0][3]).toBe(false);
      expect(backupRows()[0][4]).toBe("Restore in progress, please wait");
    });
  });
});
