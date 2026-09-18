import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// continuous-bug-hunt round 11 (notification delivery truth): performRestart()'s
// warning countdown calls _broadcastRestartMessage() in a loop that is
// deliberately best-effort and never throws -- RCON can legitimately drop
// mid-countdown even though it was verified connected right before the loop
// started (a multi-minute warning sequence has plenty of time for that).
// Before this fix, a broadcast failure was only ever a buried log.warn():
// the restart could go on to succeed completely (world saved, server back
// up) and get logged to Schedule History as an unqualified "Server
// restarted successfully", with nothing anywhere recording that players
// were never actually warned it was coming.

const logScheduleExecution = vi.fn().mockResolvedValue();
const getServer = vi.fn().mockResolvedValue(null);
const getActiveServer = vi.fn().mockResolvedValue(null);

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");

function makeRconService(overrides = {}) {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

function makeScheduler() {
  const scheduler = new Scheduler({}, {});
  scheduler.sleep = async () => {}; // no real countdown/poll delays in a test
  return scheduler;
}

describe("performRestart(): a failed warning broadcast is not silently swallowed", () => {
  beforeEach(() => {
    logScheduleExecution.mockClear();
    runManagedLifecycle.mockReset();
  });

  it("still reports the restart as successful (world was saved, server came back), but notes the warning never reached players", async () => {
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });
    const scheduler = makeScheduler();

    // RCON is genuinely connected for the pre-loop verification, but the
    // one broadcast the immediate-restart branch (warningMinutes: 0) sends
    // fails -- exactly the "RCON dropped mid-countdown" shape this fix
    // covers.
    const rconService = makeRconService({
      serverMessage: vi.fn().mockResolvedValue({
        success: false,
        error: "Not connected",
      }),
    });
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: true, scanFailed: false }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      true,
      expect.stringMatching(
        /Server restarted successfully.*1 restart warning broadcast\(s\) failed to send; players may not have been warned/,
      ),
      expect.any(Number),
    );
  });

  it("does not append any warning-broadcast note when every broadcast actually delivered (no false positive from the fix)", async () => {
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });
    const scheduler = makeScheduler();

    const rconService = makeRconService();
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: true, scanFailed: false }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      true,
      expect.not.stringMatching(/warning broadcast/),
      expect.any(Number),
    );
  });
});
