import { afterEach, describe, expect, it, vi } from "vitest";

// Phase 1 finding (Oscar, 2026-08-29): scheduler.performRestart() calls
// runManagedLifecycle()/serverManager.stopServer()/startServer() directly,
// bypassing server/routes/server.js entirely -- so NONE of the server:status
// pushes that route already makes for a plain /start or /stop ever fired
// during a restart's stop-then-start sequence, which the surrounding sleeps
// show can run 60+ real seconds. The only client-visible event during the
// whole restart used to be one terminal scheduler:action_result once
// performRestart() resolved completely.
//
// Fixed: performRestart() now pushes server:status itself at its own two
// VERIFIED transition points (old process confirmed stopped; new instance
// confirmed started), via a new Scheduler.setIo()/_emitVerifiedTransition()
// -- see scheduler.js's own comments for why this is safe alongside the
// index.js status watchdog rather than a second, racing emitter.
//
// 2026-09-07 STARTING-state fix: every {running:true} emit below now also
// carries a `phase` -- the "new instance confirmed up" emit was itself the
// exact premature-green-dot lie POST /start used to tell before its own fix
// (RCON can still take 60-240s after this point per the surrounding code's
// own comment), so it now says 'starting' instead of a bare boolean unless
// RCON already happens to be connected. A second, terminal correction fires
// once the RCON-wait loop settles either way (resolveServerPhase() ->
// 'running' or 'unresponsive'), since the periodic watchdog can't be
// trusted to catch this on its own (see _emitVerifiedTransition's comment).
// These fixture rconServices report `connected: true` throughout (nothing
// in the mock ever flips it), so every phase below resolves to 'running' --
// the starting/unresponsive branches get their own dedicated tests further
// down in this file.

const getServer = vi.fn();
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { default: panelBridge } = await import("../services/panelBridge.js");

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

describe("performRestart() pushes server:status at its own verified transitions", () => {
  afterEach(() => {
    getServer.mockReset();
    getActiveServer.mockReset();
    runManagedLifecycle.mockReset();
  });

  it("native restart: emits {running:false} once the old process is confirmed stopped, then {running:true} once the new one is confirmed up", async () => {
    // No serverName on either lookup -- keeps _backupConfigBeforeRestart()
    // and refreshLaunchTargetBeforeStart() harmless no-ops (see their own
    // early-return guards) instead of needing a real filesystem fixture,
    // which is irrelevant to what this test is checking.
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: false });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {}; // no real countdown/poll delays in a test
    scheduler.setIo({ emit });

    const rconService = makeRconService();
    // First call (initial wasRunning check) reports running; every call
    // after that (inside the "wait for the old process to actually exit"
    // loop) reports it gone, so that loop exits on its very first check.
    const getServerProcessDetails = vi
      .fn()
      .mockResolvedValueOnce({ running: true, scanFailed: false })
      .mockResolvedValue({ running: false, scanFailed: false });
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails,
      startServer: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    const calls = emit.mock.calls.filter(([event]) => event === "server:status");
    expect(calls).toEqual([
      ["server:status", { running: false, phase: "stopped" }],
      ["server:status", { running: true, phase: "running" }],
      ["server:status", { running: true, phase: "running" }],
    ]);
  });

  it("Docker-managed restart: emits only {running:true} transitions -- there is no separately-observable stopped moment (docker restart is atomic)", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    scheduler.setIo({ emit });

    const rconService = makeRconService();
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    const calls = emit.mock.calls.filter(([event]) => event === "server:status");
    expect(calls).toEqual([
      ["server:status", { running: true, phase: "running" }],
      ["server:status", { running: true, phase: "running" }],
    ]);
  });

  it("native restart with RCON actually down during the swap: 'starting' the moment the new process is up, corrected to 'running' once RCON reconnects during the wait", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: false });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    scheduler.setIo({ emit });

    // hostRunning models the actual JVM: true before the restart, flipped
    // false by quit() (old instance exits), flipped true again by
    // startServer() (new instance spawns) -- getServerProcessDetails() is
    // called at every phase of performRestart (initial wasRunning check,
    // old-process-stop confirmation, new-instance-started poll) and must
    // answer each honestly for the phase transitions below to mean anything.
    let hostRunning = true;
    // performRestart's OWN pre-restart sanity check calls connect() once
    // before any of the stop/start sequence even begins ("RCON not
    // connected, attempting to connect..."), separate from the post-restart
    // RCON-wait loop this test actually cares about -- only the SECOND call
    // (the wait loop's first attempt) should succeed, or the phase never
    // observably becomes 'starting' at all.
    let connectAttempts = 0;
    const rconService = makeRconService({
      connected: false,
      quit: vi.fn().mockImplementation(async () => {
        hostRunning = false;
        return { success: true };
      }),
      connect: vi.fn().mockImplementation(async function () {
        connectAttempts++;
        if (connectAttempts >= 2) this.connected = true;
      }),
    });
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn(async () => ({ running: hostRunning, scanFailed: false })),
      startServer: vi.fn().mockImplementation(async () => {
        hostRunning = true;
        return { success: true };
      }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    const calls = emit.mock.calls.filter(([event]) => event === "server:status");
    expect(calls).toEqual([
      ["server:status", { running: false, phase: "stopped" }],
      ["server:status", { running: true, phase: "starting" }],
      ["server:status", { running: true, phase: "running" }],
    ]);
  });

  it("native restart where RCON never reconnects: settles on 'unresponsive', not 'starting' forever", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: false });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    scheduler.setIo({ emit });

    let hostRunning = true;
    const rconService = makeRconService({
      connected: false,
      quit: vi.fn().mockImplementation(async () => {
        hostRunning = false;
        return { success: true };
      }),
      // Never actually connects -- resolves without ever setting `connected`.
      connect: vi.fn().mockResolvedValue(undefined),
    });
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn(async () => ({ running: hostRunning, scanFailed: false })),
      startServer: vi.fn().mockImplementation(async () => {
        hostRunning = true;
        return { success: true };
      }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    const calls = emit.mock.calls.filter(([event]) => event === "server:status");
    expect(calls).toEqual([
      ["server:status", { running: false, phase: "stopped" }],
      ["server:status", { running: true, phase: "starting" }],
      ["server:status", { running: true, phase: "unresponsive" }],
    ]);
  });

  // The old process's last PanelBridge heartbeat outlives it
  // (PanelBridge.markServerExited()). This sequence pushes its own verified
  // transitions instead of going through the status watchdog, and the old
  // process is only down for a few seconds, so the watchdog usually never
  // saw the stop -- PanelBridge read Up through the new process's world
  // load on the previous run's heartbeat.
  it("native restart of the active server: expires the old PanelBridge heartbeat before pushing {running:false}", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue({ id: 1 });
    runManagedLifecycle.mockResolvedValue({ handled: false });
    const markSpy = vi.spyOn(panelBridge, "markServerExited").mockImplementation(() => {});

    try {
      const emit = vi.fn();
      const scheduler = new Scheduler({}, {});
      scheduler.sleep = async () => {};
      scheduler.setIo({ emit });
      const serverManager = {
        _serverId: 1,
        getServerProcessDetails: vi
          .fn()
          .mockResolvedValueOnce({ running: true, scanFailed: false })
          .mockResolvedValue({ running: false, scanFailed: false }),
        startServer: vi.fn().mockResolvedValue({ success: true }),
      };

      await scheduler.performRestart(0, { rconService: makeRconService(), serverManager });

      expect(markSpy).toHaveBeenCalledTimes(1);
      const stoppedPush = emit.mock.calls.findIndex(
        ([event, payload]) => event === "server:status" && payload.running === false,
      );
      expect(markSpy.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[stoppedPush]);
    } finally {
      markSpy.mockRestore();
    }
  });

  it("native restart of a server that is not the active one: leaves the active server's heartbeat alone", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue({ id: 2 }); // panelBridge watches server 2
    runManagedLifecycle.mockResolvedValue({ handled: false });
    const markSpy = vi.spyOn(panelBridge, "markServerExited").mockImplementation(() => {});

    try {
      const scheduler = new Scheduler({}, {});
      scheduler.sleep = async () => {};
      scheduler.setIo({ emit: vi.fn() });
      const serverManager = {
        _serverId: 1,
        getServerProcessDetails: vi
          .fn()
          .mockResolvedValueOnce({ running: true, scanFailed: false })
          .mockResolvedValue({ running: false, scanFailed: false }),
        startServer: vi.fn().mockResolvedValue({ success: true }),
      };

      await scheduler.performRestart(0, { rconService: makeRconService(), serverManager });

      expect(markSpy).not.toHaveBeenCalled();
    } finally {
      markSpy.mockRestore();
    }
  });

  it("does not throw when no io has been wired (setIo never called)", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    // Deliberately no scheduler.setIo(...) call.

    const rconService = makeRconService();
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    };

    await expect(
      scheduler.performRestart(0, { rconService, serverManager }),
    ).resolves.toMatchObject({ success: true });
  });
});
