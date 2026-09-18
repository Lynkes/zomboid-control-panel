import { beforeEach, describe, expect, it, vi } from "vitest";

// continuous-bug-hunt round 10 (scheduled task results): Scheduler.runTaskNow()'s
// duplicate-execution guard -- refusing to run a task whose previous fire is
// still in flight -- used to return early with zero Schedule History trace.
// Every OTHER refusal path in this file (a missed cron tick, a busy
// lifecycle lock, RCON unreachable, a failed process scan) already writes a
// history entry; this was the one exception, and it's a real, reachable gap:
// a "restart" task's own run can take several minutes (warning countdown +
// RCON wait loop), so a tight interval or a manual "Run now" click while one
// is still in flight would silently vanish from the audit trail, looking
// identical to a healthy schedule with nothing due.

const logScheduleExecution = vi.fn(async () => {});
const updateTaskLastRun = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(async () => []),
  updateTaskLastRun: (...args) => updateTaskLastRun(...args),
  logServerEvent: vi.fn(async () => {}),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

const { Scheduler } = await import("../services/scheduler.js");

function makeScheduler() {
  const rconService = {
    connected: true,
    save: vi.fn(async () => ({ success: true })),
  };
  const serverManager = { _serverId: null };
  return new Scheduler(rconService, serverManager);
}

beforeEach(() => {
  logScheduleExecution.mockClear();
  updateTaskLastRun.mockClear();
});

describe("Scheduler.runTaskNow(): overlap refusal is recorded, not silent", () => {
  it("logs a false Schedule History entry when a task's previous run is still in flight, instead of leaving no trace", async () => {
    const scheduler = makeScheduler();
    const task = { id: 99, name: "Nightly save", command: "save" };

    // Simulate "already running" the same way the real in-flight guard does.
    scheduler.runningTasks.add(99);

    const result = await scheduler.runTaskNow(task);

    expect(result).toEqual({ success: false, message: "Already running" });
    expect(logScheduleExecution).toHaveBeenCalledWith(
      99,
      "Nightly save",
      "save",
      false,
      "Already running",
      0,
    );
    // The skip must not be mistaken for a real attempt.
    expect(updateTaskLastRun).not.toHaveBeenCalled();
  });

  it("still runs normally (and logs a real success) once the previous run is no longer in flight", async () => {
    const scheduler = makeScheduler();
    const task = { id: 100, name: "Nightly save", command: "save" };

    const result = await scheduler.runTaskNow(task);

    expect(result.success).toBe(true);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      100,
      "Nightly save",
      "save",
      true,
      "Completed successfully",
      expect.any(Number),
    );
  });
});
