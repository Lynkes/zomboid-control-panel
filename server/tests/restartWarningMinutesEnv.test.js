import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RESTART_WARNING_MINUTES=0 became 5: the default countdown was
// `parseInt(env, 10) || 5`, so the one value that means "restart at once" was
// read as "unset", and nothing capped a huge value (the restart-overlap
// warning and the deferred-backup wait are sized from this number).

const getServer = vi.fn();
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn().mockResolvedValue({ handled: false }),
}));

const { parseDefaultRestartWarningMinutes } = await import("../utils/restartWarning.js");
const { Scheduler, defaultRestartWarningMinutes } = await import("../services/scheduler.js");

describe("parseDefaultRestartWarningMinutes()", () => {
  it("unset or blank: the 5-minute default, nothing to report", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(parseDefaultRestartWarningMinutes(raw)).toEqual({ minutes: 5, note: null });
    }
  });

  it("0 is a real value (restart at once), not 'unset'", () => {
    expect(parseDefaultRestartWarningMinutes("0")).toEqual({ minutes: 0, note: null });
    expect(parseDefaultRestartWarningMinutes(" 0 ")).toEqual({ minutes: 0, note: null });
  });

  it("1-60 are used as given", () => {
    expect(parseDefaultRestartWarningMinutes("1")).toEqual({ minutes: 1, note: null });
    expect(parseDefaultRestartWarningMinutes("15")).toEqual({ minutes: 15, note: null });
    expect(parseDefaultRestartWarningMinutes("60")).toEqual({ minutes: 60, note: null });
  });

  it("a value above 60 is held to 60 and the log is told", () => {
    const { minutes, note } = parseDefaultRestartWarningMinutes("90");
    expect(minutes).toBe(60);
    expect(note).toMatch(/RESTART_WARNING_MINUTES=90 is above the 60-minute maximum -- using 60/);
    expect(parseDefaultRestartWarningMinutes("99999999999999999999").minutes).toBe(60);
    expect(parseDefaultRestartWarningMinutes("9".repeat(400)).minutes).toBe(60);
  });

  it("anything that is not a whole non-negative number falls back to 5 and says so", () => {
    for (const raw of ["abc", "-3", "2.5", "1e2", "5min", "NaN", "Infinity"]) {
      const { minutes, note } = parseDefaultRestartWarningMinutes(raw);
      expect(minutes).toBe(5);
      expect(note).toMatch(/is not a whole number of minutes \(0-60\) -- using 5/);
    }
  });

  it("quotes a long or odd value safely in the note", () => {
    const { note } = parseDefaultRestartWarningMinutes("x".repeat(200) + "\nforged log line");
    expect(note).not.toMatch(/\n/);
    expect(note.length).toBeLessThan(200);
  });
});

describe("the default countdown performRestart() uses", () => {
  const original = process.env.RESTART_WARNING_MINUTES;
  afterEach(() => {
    if (original === undefined) delete process.env.RESTART_WARNING_MINUTES;
    else process.env.RESTART_WARNING_MINUTES = original;
  });

  it("follows the environment variable, 0 included", () => {
    delete process.env.RESTART_WARNING_MINUTES;
    expect(defaultRestartWarningMinutes()).toBe(5);
    process.env.RESTART_WARNING_MINUTES = "0";
    expect(defaultRestartWarningMinutes()).toBe(0);
    process.env.RESTART_WARNING_MINUTES = "12";
    expect(defaultRestartWarningMinutes()).toBe(12);
    process.env.RESTART_WARNING_MINUTES = "500";
    expect(defaultRestartWarningMinutes()).toBe(60);
    process.env.RESTART_WARNING_MINUTES = "soon";
    expect(defaultRestartWarningMinutes()).toBe(5);
  });

  describe("an unattended restart with RESTART_WARNING_MINUTES=0", () => {
    beforeEach(() => {
      getServer.mockReset().mockResolvedValue(null);
      getActiveServer.mockReset().mockResolvedValue({ id: 1, isRemote: false });
    });

    const sleepsOf = (scheduler, ms) => scheduler.sleep.mock.calls.filter(([n]) => n === ms).length;

    function harness() {
      const scheduler = new Scheduler({}, {});
      scheduler.sleep = vi.fn(async () => {});
      const warningMinutesSeen = [];
      const rconService = {
        connected: true,
        execute: vi.fn().mockResolvedValue({ success: true }),
        save: vi.fn().mockResolvedValue({ success: true }),
        serverMessage: vi.fn(async () => {
          warningMinutesSeen.push(scheduler.activeRestart?.warningMinutes);
          return { success: true };
        }),
        quit: vi.fn().mockResolvedValue({ success: true }),
        connect: vi.fn().mockResolvedValue(),
      };
      const serverManager = {
        _serverId: 1,
        getServerProcessDetails: vi
          .fn()
          .mockResolvedValueOnce({ running: true, scanFailed: false })
          .mockResolvedValue({ running: false, scanFailed: false }),
        startServer: vi.fn().mockResolvedValue({ success: true }),
      };
      return { scheduler, rconService, serverManager, warningMinutesSeen };
    }

    it("restarts at once: one 'restarting' notice, no minute-by-minute countdown", async () => {
      process.env.RESTART_WARNING_MINUTES = "0";
      const { scheduler, rconService, serverManager, warningMinutesSeen } = harness();

      const result = await scheduler.performRestart(null, { rconService, serverManager });

      expect(result.success).toBe(true);
      expect(warningMinutesSeen).toEqual([0]);
      expect(rconService.serverMessage).toHaveBeenCalledTimes(1);
      // The only 60 s sleep left is the wait for RCON after the relaunch.
      expect(sleepsOf(scheduler, 60000)).toBe(1);
    });

    it("an unset variable still counts down 5 minutes (control)", async () => {
      delete process.env.RESTART_WARNING_MINUTES;
      const { scheduler, rconService, serverManager, warningMinutesSeen } = harness();

      await scheduler.performRestart(null, { rconService, serverManager });

      expect(warningMinutesSeen[0]).toBe(5);
      expect(rconService.serverMessage.mock.calls.length).toBeGreaterThan(5);
      // Four countdown minutes between the five warnings, plus the RCON wait.
      expect(sleepsOf(scheduler, 60000)).toBe(5);
    });
  });
});
