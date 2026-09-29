import { afterEach, describe, expect, it, vi } from "vitest";

const logScheduleExecution = vi.fn().mockResolvedValue();
const server = { id: 7, serverName: "Fresh" };
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(async () => server),
  getServer: vi.fn(async () => server),
}));
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn().mockResolvedValue({ handled: false }),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { namedStartupScriptMissingError } = await import("../services/serverManager.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

// GH #167 follow-up: a scheduled "restart" task whose start THROWS --
// serverManager.startServer()'s SERVER_START_SCRIPT_MISSING refusal is the
// documented case (troubleshooting.md sends the operator to Execution
// History for it) -- wrote two Schedule History rows for one execution:
// performRestart()'s own catch logged it, rethrew, and runTaskNow()'s catch
// logged it again, because only a RETURNED { logged: true } failure was
// tagged alreadyLoggedToScheduleHistory. Drives the real performRestart()
// down its "server was not running" branch to a start that throws.
describe("a scheduled restart task whose start throws", () => {
  afterEach(() => {
    logScheduleExecution.mockClear();
    const stray = acquireLifecycleLock("test-cleanup");
    if (stray) stray.release();
  });

  it("writes one Schedule History row, not two", async () => {
    const refusal = namedStartupScriptMissingError({
      script: "start-server_Fresh.sh",
      folder: "/srv/pz",
      fallback: "start-server.sh",
    });
    const rconService = {
      connected: false,
      execute: vi.fn().mockResolvedValue({ success: false }),
    };
    const serverManager = {
      _serverId: 7,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: false, scanFailed: false }),
      startServer: vi.fn().mockRejectedValue(refusal),
    };
    const scheduler = new Scheduler(rconService, serverManager);
    scheduler.sleep = async () => {};

    const result = await scheduler.runTaskNow({
      id: 30,
      name: "Nightly restart",
      command: "restart",
    });

    expect(serverManager.startServer).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.message).toContain("start-server_Fresh.sh");
    expect(logScheduleExecution).toHaveBeenCalledTimes(1);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      expect.stringContaining("start-server_Fresh.sh"),
      expect.any(Number),
    );
  });

  it("still writes the task's own row when the restart throws before performRestart() logged anything", async () => {
    const scheduler = new Scheduler({ connected: false, execute: vi.fn() }, { _serverId: 7 });
    scheduler.performRestart = vi.fn().mockRejectedValue(new Error("unexpected"));

    const result = await scheduler.runTaskNow({ id: 31, name: "Nightly restart", command: "restart" });

    expect(result.success).toBe(false);
    expect(logScheduleExecution).toHaveBeenCalledTimes(1);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      31,
      "Nightly restart",
      "restart",
      false,
      "unexpected",
      expect.any(Number),
    );
  });
});
