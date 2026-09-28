import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-27 Discord report (Linux/Docker operator, server "Tavern"): the
// Dashboard showed "Scheduled backup failing -- Skipped: a restart was in
// progress" permanently. A restart schedule and the backup schedule fired at
// the same times, the scheduled-backup cron callback saw restartInProgress
// and DROPPED the backup (logging a failure), so every single scheduled
// backup was lost and nothing could clear the warning.
//
// The fix holds a colliding backup until the restart ends and runs it then
// (see scheduler.js _onScheduledBackupTick() for why after, not before),
// with a bounded wait so a stuck restart becomes a real, explained failure
// instead of a backup that silently never happens. These tests drive the
// real Scheduler with fake timers; before the fix, the first one fails --
// createBackup is never called and a failure row is logged instead.

const logScheduleExecution = vi.fn().mockResolvedValue();
const getScheduledTasks = vi.fn().mockResolvedValue([]);

vi.mock("../database/init.js", () => ({
  getScheduledTasks: (...args) => getScheduledTasks(...args),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(),
  getServer: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
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

const MINUTE = 60 * 1000;
const backupRows = () =>
  logScheduleExecution.mock.calls.filter((call) => call[2] === "backup");

describe("Scheduler: a scheduled backup that lands on a restart is deferred, not dropped", () => {
  let scheduler;
  let createBackup;
  let settings;

  // What performRestart() itself does on entry/exit (restartInProgress and
  // activeRestart are set together, synchronously, and cleared together in
  // its finally) -- driven directly here so the test controls how long the
  // "restart" lasts without simulating RCON, process scans and sleeps.
  const beginRestart = (warningMinutes = 5) => {
    scheduler.restartInProgress = true;
    scheduler.activeRestart = { startedAt: Date.now(), warningMinutes };
  };
  const endRestart = () => {
    scheduler.restartInProgress = false;
    scheduler.activeRestart = null;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T04:00:00.000Z"));
    capturedBackupCallback = null;
    logScheduleExecution.mockClear();
    getScheduledTasks.mockReset().mockResolvedValue([]);
    scheduler = new Scheduler({}, {});
    createBackup = vi.fn().mockResolvedValue({
      success: true,
      backup: { name: "Tavern_2026-09-27.zip" },
    });
    settings = { enabled: true, schedule: "0 */4 * * *", includeDb: false };
    scheduler.setBackupService({
      getSettings: vi.fn(async () => ({ ...settings })),
      createBackup,
    });
    await scheduler.setupBackupSchedule();
    expect(capturedBackupCallback).toBeTypeOf("function");
  });

  afterEach(() => {
    scheduler.stopAllJobs();
    vi.useRealTimers();
  });

  it("waits for the restart, then runs the backup and logs one success -- no failure row", async () => {
    beginRestart();
    const tick = capturedBackupCallback();

    // Mid-restart: nothing archived, nothing logged, and the wait is visible.
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(createBackup).not.toHaveBeenCalled();
    expect(backupRows()).toHaveLength(0);
    expect(scheduler.getDeferredBackupSince()).toBe("2026-09-27T04:00:00.000Z");

    // Restart finishes 8 minutes in; the next poll picks the backup up.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(createBackup).toHaveBeenCalledWith({ includeDb: false });
    const rows = backupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe(true);
    expect(rows[0][4]).toMatch(/^Created: Tavern_2026-09-27\.zip -- held back until a server restart/);
    expect(scheduler.getDeferredBackupSince()).toBeNull();
    expect(scheduler.deferredBackup).toBeNull();
  });

  it("still runs the backup when the restart ended in failure (the restart sequence is over either way)", async () => {
    beginRestart();
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    // performRestart()'s finally clears the flags whether it succeeded or not.
    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(backupRows()[0][3]).toBe(true);
  });

  it("folds a second tick that lands during the wait into the first -- one backup, not a racing pair", async () => {
    beginRestart();
    const first = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(MINUTE);
    const second = capturedBackupCallback(); // e.g. a */15 schedule's next tick
    await second;
    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await first;

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(backupRows()).toHaveLength(1);
    expect(backupRows()[0][3]).toBe(true);
  });

  it("gives up on a stuck restart with a real, explained failure instead of waiting forever", async () => {
    beginRestart(5);
    const tick = capturedBackupCallback();

    // A 5-minute countdown (each minute allowed 30 s of broadcast overrun,
    // so 7.5) plus the restart-sequence budget (20 min) is 27.5 minutes;
    // still inside it, nothing is logged yet.
    await vi.advanceTimersByTimeAsync(27 * MINUTE);
    expect(backupRows()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MINUTE);
    await tick;

    expect(createBackup).not.toHaveBeenCalled();
    const rows = backupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe(false);
    expect(rows[0][4]).toMatch(
      /^Not run: the server restart had been running for 28 min \(5-minute warning\) without finishing -- .* so it looked stuck, and manual backups were blocked while it lasted\./,
    );
    // A next step that works in this state: createBackup() refuses manual
    // backups too while the restart flag is up, and only a panel restart
    // clears a restart hung past its countdown.
    expect(rows[0][4]).toMatch(/restart the panel to clear it/);
    expect(rows[0][4]).toMatch(/Creating a backup after that also clears the failed-backup warning/);
    // Review finding: the row is the Dashboard's "Scheduled backup failing"
    // detail until the next tick -- hours later on a daily schedule, and
    // typically after the operator restarted the panel as advised. Written
    // as a record of that moment, it stays true then; "still hasn't
    // finished" / "are blocked" would claim a stuck restart that is gone.
    expect(rows[0][4]).not.toMatch(/still hasn't|hasn't finished|are blocked|looks stuck|min ago/);
    // Shown verbatim on the Dashboard and the Backups card: no raw UTC ISO
    // timestamps, which read as the wrong time next to a local browser.
    expect(rows[0][4]).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // Review finding: the English prose was shown verbatim in every locale.
    // The row also carries a message key and its numbers, which the pages
    // render translated; the English above stays for logs and old clients.
    expect(rows[0][6]).toEqual({
      messageKey: "restartStuck",
      messageParams: { minutes: 28, warningMinutes: 5 },
    });
    // The wait is over -- the next tick gets a fresh chance.
    expect(scheduler.getDeferredBackupSince()).toBeNull();
  });

  it("keys the row by how long the backup waited when the running restart's own start isn't known", async () => {
    // restartInProgress with no activeRestart record: the deadline and the
    // message fall back to the moment the backup came due.
    scheduler.restartInProgress = true;
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(111 * MINUTE);
    await tick;

    const rows = backupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0][4]).toMatch(/^Not run: the server restart running when this backup came due still hadn't finished (\d+) min later/);
    const minutes = Number(rows[0][4].match(/finished (\d+) min later/)[1]);
    expect(rows[0][6]).toEqual({ messageKey: "restartStuckSinceDue", messageParams: { minutes } });
    expect(createBackup).not.toHaveBeenCalled();
    scheduler.restartInProgress = false;
  });

  it("a later tick during the SAME stuck restart reports how long the restart has been running, not '0 min'", async () => {
    // Review finding: the second tick arrives already past the deadline
    // (it's measured from the restart's own start), so it gives up at
    // once -- and its row, the newest one, is what the Dashboard shows.
    beginRestart(5);
    const first = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(28 * MINUTE);
    await first;

    // 08:00 -- the next "0 */4 * * *" tick, the restart still hung.
    vi.setSystemTime(new Date("2026-09-27T08:00:00.000Z"));
    const second = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(0);
    await second;

    const rows = backupRows();
    expect(rows).toHaveLength(2);
    expect(rows[1][3]).toBe(false);
    expect(rows[1][4]).toMatch(/the server restart had been running for 240 min \(5-minute warning\) without finishing/);
    expect(rows[1][4]).not.toMatch(/\b0 min\b/);
    expect(rows[1][6]).toEqual({
      messageKey: "restartStuck",
      messageParams: { minutes: 240, warningMinutes: 5 },
    });
    expect(createBackup).not.toHaveBeenCalled();
  });

  it("measures 'stuck' against the running restart's own countdown -- a 60-minute manual countdown is not stuck at minute 30", async () => {
    beginRestart(60);
    const tick = capturedBackupCallback();

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(backupRows()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(35 * MINUTE);
    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(backupRows()).toHaveLength(1);
    expect(backupRows()[0][3]).toBe(true);
  });

  it("allows a long countdown its broadcast overrun: a 60-minute restart whose warnings time out against a degraded RCON is not stuck at minute 85", async () => {
    // Review finding: each countdown minute is a 60 s sleep PLUS its warning
    // broadcast, which against an unresponsive RCON can take a connect and
    // a command timeout (~23 s) -- about 20 extra minutes over a 60-minute
    // countdown. Measured as a bare 60 min + 20 min budget, this healthy
    // restart was called stuck at minute 80 and its backup dropped.
    beginRestart(60);
    const tick = capturedBackupCallback();

    await vi.advanceTimersByTimeAsync(85 * MINUTE);
    expect(backupRows()).toHaveLength(0);

    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(backupRows()).toHaveLength(1);
    expect(backupRows()[0][3]).toBe(true);
  });

  it("drops the held backup (silently) if scheduled backups were turned off while it waited", async () => {
    beginRestart();
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(MINUTE);
    settings.enabled = false;
    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(createBackup).not.toHaveBeenCalled();
    expect(backupRows()).toHaveLength(0);
  });

  it("stopAllJobs() ends the wait (panel shutdown) without running or logging anything", async () => {
    beginRestart();
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(MINUTE);
    scheduler.stopAllJobs();
    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;

    expect(createBackup).not.toHaveBeenCalled();
    expect(backupRows()).toHaveLength(0);
  });

  it("end to end with a real performRestart(): the held backup runs only once the restart has fully finished", async () => {
    // Docker-managed path: the shortest real restart sequence (world save,
    // `docker restart`, RCON wait) with every step mocked to succeed.
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });
    const order = [];
    const rconService = {
      connected: true,
      execute: vi.fn().mockResolvedValue({ success: true }),
      serverMessage: vi.fn().mockResolvedValue({ success: true }),
      save: vi.fn(async () => {
        order.push("world save");
        return { success: true };
      }),
    };
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    };
    createBackup.mockImplementation(async () => {
      order.push(scheduler.restartInProgress ? "backup DURING restart" : "backup after restart");
      return { success: true, backup: { name: "Tavern_2026-09-27.zip" } };
    });

    const restart = scheduler.performRestart(0, { rconService, serverManager });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.restartInProgress).toBe(true);
    expect(scheduler.activeRestart).toEqual({ startedAt: Date.now(), warningMinutes: 0 });

    const tick = capturedBackupCallback(); // same minute as the restart
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect((await restart).success).toBe(true);
    await tick;

    expect(order).toEqual(["world save", "backup after restart"]);
    expect(scheduler.activeRestart).toBeNull();
    expect(backupRows()).toHaveLength(1);
    expect(backupRows()[0][3]).toBe(true);
  });

  it("same-second tie (the reported setup): a restart that claims the flag just AFTER the backup tick fired still holds the backup", async () => {
    // node-cron gives no order between two jobs due in the same second, and
    // performRestart() sets restartInProgress only after an await -- so the
    // backup tick can run first and see no restart at all.
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });
    const order = [];
    const rconService = {
      connected: true,
      execute: vi.fn().mockResolvedValue({ success: true }),
      serverMessage: vi.fn().mockResolvedValue({ success: true }),
      save: vi.fn(async () => {
        order.push("world save");
        return { success: true };
      }),
    };
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    };
    createBackup.mockImplementation(async () => {
      order.push(scheduler.restartInProgress ? "backup DURING restart" : "backup after restart");
      return { success: true, backup: { name: "Tavern_2026-09-27.zip" } };
    });

    const tick = capturedBackupCallback(); // the backup's heartbeat wins
    expect(scheduler.restartInProgress).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    const restart = scheduler.performRestart(0, { rconService, serverManager });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.restartInProgress).toBe(true);
    expect(createBackup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect((await restart).success).toBe(true);
    await tick;

    expect(order).toEqual(["world save", "backup after restart"]);
    expect(backupRows()).toHaveLength(1);
    expect(backupRows()[0][3]).toBe(true);
    expect(backupRows()[0][4]).toMatch(/held back until a server restart/);
  });

  it("tells open pages when a held backup starts waiting and when it starts running", async () => {
    const emit = vi.fn();
    scheduler.setIo({ emit });
    beginRestart();
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledWith("backup:deferred", { since: "2026-09-27T04:00:00.000Z" });

    endRestart();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    await tick;
    expect(emit).toHaveBeenLastCalledWith("backup:deferred", { since: null });
    expect(emit.mock.calls.filter(([event]) => event === "backup:deferred")).toHaveLength(2);
  });

  it("positive control: with no restart running, the tick backs up after its short settle, with no deferral note", async () => {
    const tick = capturedBackupCallback();
    await vi.advanceTimersByTimeAsync(4 * 1000);
    expect(createBackup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await tick;

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(backupRows()).toHaveLength(1);
    expect(backupRows()[0][4]).toBe("Created: Tavern_2026-09-27.zip");
  });
});

describe("Scheduler.getBackupRestartOverlaps(): which scheduled restarts the backup schedule lands inside", () => {
  let scheduler;

  beforeEach(() => {
    getScheduledTasks.mockReset();
    scheduler = new Scheduler({}, {});
    scheduler.effectiveTimezone = "UTC";
  });

  it("names an enabled restart task on the same cadence (the reported setup: both every 4 hours on the hour)", async () => {
    getScheduledTasks.mockResolvedValue([
      { id: 1, name: "Restart every 4h", cron_expression: "0 */4 * * *", command: "restart", enabled: 1 },
      { id: 2, name: "Hourly save", cron_expression: "0 * * * *", command: "save", enabled: 1 },
      { id: 3, name: "Old restart", cron_expression: "0 */4 * * *", command: "restart", enabled: 0 },
    ]);

    const overlaps = await scheduler.getBackupRestartOverlaps("0 */4 * * *");

    expect(overlaps).toEqual([
      {
        kind: "task",
        name: "Restart every 4h",
        cron: "0 */4 * * *",
        restartTime: "00:00",
        backupTime: "00:00",
        timezone: "UTC",
        allBackups: true,
        // performRestart()'s default 5-minute countdown plus the typical
        // 5-minute save/quit/relaunch tail.
        windowMinutes: 10,
      },
    ]);
  });

  it("includes AUTO_RESTART_CRON when auto-restart is armed", async () => {
    getScheduledTasks.mockResolvedValue([]);
    scheduler.autoRestartJob = { stop: vi.fn() };
    scheduler.autoRestartCron = "0 */6 * * *";

    const overlaps = await scheduler.getBackupRestartOverlaps("5 */6 * * *");

    expect(overlaps).toEqual([
      expect.objectContaining({ kind: "autoRestart", cron: "0 */6 * * *", restartTime: "00:00", backupTime: "00:05" }),
    ]);
  });

  it("is empty for a staggered schedule (backups at :30, restarts on the hour)", async () => {
    getScheduledTasks.mockResolvedValue([
      { id: 1, name: "Restart every 4h", cron_expression: "0 */4 * * *", command: "restart", enabled: 1 },
    ]);

    expect(await scheduler.getBackupRestartOverlaps("30 */4 * * *")).toEqual([]);
  });
});
