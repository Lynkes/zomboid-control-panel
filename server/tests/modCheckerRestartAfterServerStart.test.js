import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// GH #189 (panel 1.4.1, Docker all-in-one): a cron task checks for mod
// updates every 2 hours, auto-restart is on with a 5 min warning, "delay if
// players online" and a 120 min maximum. Updates found while players were
// on left a restart waiting for them to leave; the operator then restarted
// the game server by hand -- which loads the updated Workshop mods -- and
// the waiting restart still went ahead later, restarting the server a second
// time for nothing. A pending mod-update restart now ends when the server is
// started again after the update was detected, by any path, and only then.

const db = vi.hoisted(() => ({ active: { id: "s1", name: "One" } }));

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  addTrackedMod: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => db.active),
  getServer: vi.fn(async () => db.active),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(async () => {}),
}));

const { ModChecker } = await import("../services/modChecker.js");
const { acquireLifecycleLock, prepareForLaunch } = await import(
  "../services/lifecycleCoordinator.js"
);
const { logServerEvent } = await import("../database/init.js");
const { resolveActiveServerStartedAt } = await import("../utils/serverStatus.js");

const MOD = { workshopId: "2001", name: "Better Sorting" };
const CANCELLED_NOTICE = "[SERVER] Restart CANCELLED.";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The reporter's settings, with every collaborator faked: RCON answers with
// `players` online, the server process (PID 4242) started an hour before
// the update was found (a start the panel didn't see), and the restart
// itself succeeds.
function makeChecker({ players = 3 } = {}) {
  const checker = new ModChecker();
  checker.delayIfPlayersOnline = true;
  checker.maxDelayMinutes = 120;
  checker.restartWarningMinutes = 5;
  const rconService = {
    connected: true,
    playerCount: players,
    getPlayers: vi.fn(async () => ({
      success: true,
      players: Array.from({ length: rconService.playerCount }, (_, i) => `p${i}`),
    })),
    serverMessage: vi.fn(async () => ({ success: true })),
  };
  checker.scheduler = {
    rconService,
    restartWarning: { locale: "en" },
    performRestart: vi.fn(async () => ({ success: true })),
    cancelRestart: vi.fn(),
  };
  checker.processPid = "4242";
  checker.processStartedAtMs = Date.now() - 60 * 60 * 1000;
  checker.serverManager = {
    getServerProcessDetails: vi.fn(async () => ({
      running: true,
      scanFailed: false,
      matched: [{ pid: checker.processPid }],
    })),
    resolveStartTime: vi.fn(async () => new Date(checker.processStartedAtMs)),
  };
  checker.io = { emit: vi.fn() };
  return { checker, rconService };
}

const restartsTriggered = (checker) => checker.scheduler.performRestart.mock.calls.length;
const cancelledEvents = () =>
  logServerEvent.mock.calls.filter(([type]) => type === "mod_update_restart_cancelled");
const broadcasts = (rconService) => rconService.serverMessage.mock.calls.map(([text]) => text);

let ticks;

beforeEach(() => {
  db.active = { id: "s1", name: "One" };
  ticks = [];
  logServerEvent.mockClear();
  // The waiting loop's 2-minute tick, run by hand.
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    ticks.push(callback);
    return ticks.length;
  });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

async function launch(serverId = "s1") {
  const { launchSeq } = await prepareForLaunch({ id: serverId });
  return { serverId, launchSeq };
}

describe("GH #189: a restart the operator made cancels the waiting mod-update restart", () => {
  it("a manual restart after the update was found cancels it, and the waiting loop never restarts the server again", async () => {
    const { checker, rconService } = makeChecker();

    const handled = await checker.handleModUpdate([MOD]);
    expect(handled).toMatchObject({ pending: true, reason: "waiting_for_players" });
    expect(checker.pendingRestart).toBe(true);
    expect(ticks).toHaveLength(1);
    expect(broadcasts(rconService)[0]).toMatch(/Restart pending - waiting for players/);
    checker.processedUpdates.set(MOD.workshopId, 1234);

    // Restart's own quit took RCON down; the launch is reported once done.
    rconService.connected = false;
    const manualRestart = await launch();
    expect(await checker.noteServerLaunched(manualRestart)).toBe(true);

    expect(checker.pendingRestart).toBe(false);
    expect(checker.playerCheckInterval).toBeNull();
    expect(cancelledEvents()).toHaveLength(1);
    expect(checker.io.emit).toHaveBeenCalledWith("mods:restart_cancelled", {
      reason: "server_restarted",
    });
    // The versions the new start loaded stay handled: they don't re-arm.
    expect(checker.processedUpdates.get(MOD.workshopId)).toBe(1234);
    // No RCON to the new process yet: nothing to broadcast to.
    expect(broadcasts(rconService)).not.toContain(CANCELLED_NOTICE);

    // The server empties later: the old loop must not restart it.
    rconService.connected = true;
    rconService.playerCount = 0;
    await ticks[0]();
    expect(restartsTriggered(checker)).toBe(0);
    expect(checker.pendingRestart).toBe(false);
  });

  it("a start that began before the update was found doesn't cancel it: the restart still happens", async () => {
    const { checker, rconService } = makeChecker();
    const earlierStart = await launch();

    await checker.handleModUpdate([MOD]);
    expect(await checker.noteServerLaunched(earlierStart)).toBe(false);
    expect(checker.pendingRestart).toBe(true);
    expect(cancelledEvents()).toHaveLength(0);

    rconService.playerCount = 0;
    await ticks[0]();
    expect(restartsTriggered(checker)).toBe(1);
  });

  it("a launch of another server on the host doesn't cancel the active server's restart", async () => {
    const { checker } = makeChecker();
    await checker.handleModUpdate([MOD]);

    expect(await checker.noteServerLaunched(await launch("s2"))).toBe(false);
    expect(await checker.noteServerLaunched({ serverId: null, launchSeq: 1e9 })).toBe(false);
    expect(checker.pendingRestart).toBe(true);
  });

  it("the mod-update restart's own relaunch doesn't cancel it", async () => {
    const { checker } = makeChecker({ players: 0 });
    let ownLaunchCancelled = null;
    checker.scheduler.performRestart = vi.fn(async () => {
      ownLaunchCancelled = await checker.noteServerLaunched(await launch());
      return { success: true };
    });

    const result = await checker.handleModUpdate([MOD]);

    expect(ownLaunchCancelled).toBe(false);
    expect(result).toMatchObject({ success: true, reason: "restart_complete" });
    expect(cancelledEvents()).toHaveLength(0);
    expect(checker.pendingRestart).toBe(false);
  });

  it("a waiting-loop tick already in flight when the server restarts doesn't restart it afterwards", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    const playersAnswer = deferred();
    rconService.getPlayers = vi.fn(() => playersAnswer.promise);
    const tick = ticks[0]();
    // Let the tick reach its RCON player query.
    await vi.waitFor(() => expect(rconService.getPlayers).toHaveBeenCalled());

    expect(await checker.noteServerLaunched(await launch())).toBe(true);
    playersAnswer.resolve({ success: true, players: [] });
    await tick;

    expect(restartsTriggered(checker)).toBe(0);
    expect(checker.pendingRestart).toBe(false);
  });

  it("a restart while the update is still being handled (waiting on RCON) leaves nothing armed", async () => {
    const { checker, rconService } = makeChecker();
    const playersAnswer = deferred();
    rconService.getPlayers = vi.fn(() => playersAnswer.promise);

    const handling = checker.handleModUpdate([MOD]);
    await vi.waitFor(() => expect(rconService.getPlayers).toHaveBeenCalled());
    expect(await checker.noteServerLaunched(await launch())).toBe(true);
    playersAnswer.resolve({ success: true, players: ["p1"] });

    expect(await handling).toMatchObject({ markProcessed: true, reason: "server_restarted" });
    expect(ticks).toHaveLength(0);
    expect(checker.pendingRestart).toBe(false);
    expect(restartsTriggered(checker)).toBe(0);
  });

  it("the operator's own Cancel while the update is still being handled leaves it eligible for the next check", async () => {
    const { checker, rconService } = makeChecker();
    const playersAnswer = deferred();
    rconService.getPlayers = vi.fn(() => playersAnswer.promise);

    const handling = checker.handleModUpdate([MOD]);
    await vi.waitFor(() => expect(rconService.getPlayers).toHaveBeenCalled());
    checker.cancelPendingRestart();
    playersAnswer.resolve({ success: true, players: ["p1"] });

    const result = await handling;
    expect(result).toMatchObject({ success: false, reason: "cancelled" });
    expect(result.markProcessed).toBeUndefined();
    expect(ticks).toHaveLength(0);
    expect(checker.pendingRestart).toBe(false);
  });

  it("the waiting loop holds off while another start/stop/restart holds the lifecycle lock", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);
    rconService.playerCount = 0;

    // A manual Restart's countdown (or a Stop) is under way.
    const lock = acquireLifecycleLock("restart", "s1");
    await ticks[0]();
    expect(restartsTriggered(checker)).toBe(0);
    expect(checker.pendingRestart).toBe(true);

    // It ended without a launch (e.g. a Stop): the restart still happens.
    lock.release();
    await ticks[0]();
    expect(restartsTriggered(checker)).toBe(1);
  });

  it("the operator's own Cancel also stops a tick already in flight", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    const playersAnswer = deferred();
    rconService.getPlayers = vi.fn(() => playersAnswer.promise);
    const tick = ticks[0]();
    await vi.waitFor(() => expect(rconService.getPlayers).toHaveBeenCalled());

    checker.cancelPendingRestart();
    playersAnswer.resolve({ success: true, players: [] });
    await tick;

    expect(restartsTriggered(checker)).toBe(0);
  });
});

describe("GH #189: a start the panel didn't make (crash restart, restart on the host)", () => {
  it("is found by the waiting loop from the process start time, and players who were told are told it's off", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    // systemd's Restart=on-failure (or Docker's restart policy) brought the
    // server back after a crash; players reconnected.
    checker.processPid = "5151";
    checker.processStartedAtMs = Date.now() + 5 * 60 * 1000;
    rconService.playerCount = 0;
    await ticks[0]();

    expect(restartsTriggered(checker)).toBe(0);
    expect(checker.pendingRestart).toBe(false);
    expect(cancelledEvents()).toHaveLength(1);
    expect(broadcasts(rconService)).toContain(CANCELLED_NOTICE);
  });

  it("a process that started before the update was found keeps the restart", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    checker.processPid = "5151";
    checker.processStartedAtMs = Date.now() - 10 * 60 * 1000;
    rconService.playerCount = 0;
    await ticks[0]();

    expect(restartsTriggered(checker)).toBe(1);
    expect(cancelledEvents()).toHaveLength(0);
  });

  it("an unknown start time keeps the restart", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    checker.processPid = "5151";
    checker.serverManager.resolveStartTime = vi.fn(async () => null);
    rconService.playerCount = 0;
    await ticks[0]();

    expect(restartsTriggered(checker)).toBe(1);
  });

  // Round 3 review (ADV-2): on Linux, /proc start times are derived from
  // the boot time, which moves 1:1 with a wall-clock step -- a Linux VM or
  // WSL2/Docker Desktop resumed from sleep, a restored snapshot. The same,
  // never-restarted process then read as started hours later, and the
  // waiting loop cancelled a restart the server still needed.
  it("a wall-clock step that moves the same process's start time keeps the restart", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    checker.processStartedAtMs += 2 * 60 * 60 * 1000;
    rconService.playerCount = 0;
    await ticks[0]();

    expect(cancelledEvents()).toHaveLength(0);
    expect(broadcasts(rconService)).not.toContain(CANCELLED_NOTICE);
    expect(restartsTriggered(checker)).toBe(1);
  });

  it("no reading of the server at detection keeps the restart", async () => {
    const { checker, rconService } = makeChecker();
    const scan = checker.serverManager.getServerProcessDetails;
    checker.serverManager.getServerProcessDetails = vi.fn(async () => ({
      running: false,
      scanFailed: true,
    }));
    await checker.handleModUpdate([MOD]);

    checker.serverManager.getServerProcessDetails = scan;
    checker.processPid = "5151";
    checker.processStartedAtMs = Date.now() + 5 * 60 * 1000;
    rconService.playerCount = 0;
    await ticks[0]();

    expect(cancelledEvents()).toHaveLength(0);
    expect(restartsTriggered(checker)).toBe(1);
  });

  it("another server made active since doesn't count as a start of this one", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);

    db.active = { id: "s2", name: "Two" };
    checker.processPid = "5151";
    checker.processStartedAtMs = Date.now() + 5 * 60 * 1000;
    rconService.playerCount = 0;
    await ticks[0]();

    expect(cancelledEvents()).toHaveLength(0);
  });
});

// Round 3 review (ADV-1): triggerModRestart() announces the restart over
// RCON and PanelBridge before calling performRestart() -- seconds of
// awaits. A launch of the server in that window was reported as a cancel
// (activity row, toast, in-game "Restart CANCELLED."), and the mod restart
// then restarted the server anyway: the #189 symptom.
describe("GH #189: a start while the mod-update restart is being announced", () => {
  function holdRestartWarning(rconService) {
    const warningSent = deferred();
    const send = rconService.serverMessage;
    rconService.serverMessage = vi.fn((text) =>
      /Server will restart in/.test(text) ? warningSent.promise : send(text),
    );
    return warningSent;
  }
  const restartWarned = (rconService) =>
    broadcasts(rconService).some((text) => /Server will restart in/.test(text));

  it("from the waiting loop: the start cancels it and no restart follows", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);
    const warningSent = holdRestartWarning(rconService);

    rconService.playerCount = 0;
    const tick = ticks[0]();
    await vi.waitFor(() => expect(restartWarned(rconService)).toBe(true));
    expect(await checker.noteServerLaunched(await launch())).toBe(true);
    warningSent.resolve({ success: true });
    await tick;

    expect(restartsTriggered(checker)).toBe(0);
    expect(checker.pendingRestart).toBe(false);
    expect(cancelledEvents()).toHaveLength(1);
    expect(checker.io.emit).not.toHaveBeenCalledWith("mods:restart_failed", expect.anything());
  });

  it("an immediate restart (nobody on): the start cancels it, players hear it's off, the update stays handled", async () => {
    const { checker, rconService } = makeChecker({ players: 0 });
    const warningSent = holdRestartWarning(rconService);

    const handling = checker.handleModUpdate([MOD]);
    await vi.waitFor(() => expect(restartWarned(rconService)).toBe(true));
    // The old process's RCON is still up when the launch is reported.
    expect(await checker.noteServerLaunched(await launch())).toBe(true);
    warningSent.resolve({ success: true });

    expect(await handling).toMatchObject({
      success: true,
      markProcessed: true,
      reason: "server_restarted",
    });
    expect(restartsTriggered(checker)).toBe(0);
    expect(broadcasts(rconService)).toContain(CANCELLED_NOTICE);
  });

  it("the operator's own Cancel while it is being announced also stops it", async () => {
    const { checker, rconService } = makeChecker({ players: 0 });
    const warningSent = holdRestartWarning(rconService);

    const handling = checker.handleModUpdate([MOD]);
    await vi.waitFor(() => expect(restartWarned(rconService)).toBe(true));
    checker.cancelPendingRestart();
    warningSent.resolve({ success: true });

    expect(await handling).toMatchObject({ success: false, reason: "cancelled" });
    expect(restartsTriggered(checker)).toBe(0);
  });

  it("a newer update armed after that cancel stays armed when the old announcement ends", async () => {
    const { checker, rconService } = makeChecker();
    await checker.handleModUpdate([MOD]);
    const warningSent = holdRestartWarning(rconService);

    rconService.playerCount = 0;
    const tick = ticks[0]();
    await vi.waitFor(() => expect(restartWarned(rconService)).toBe(true));
    expect(await checker.noteServerLaunched(await launch())).toBe(true);

    rconService.playerCount = 2;
    expect(
      await checker.handleModUpdate([{ workshopId: "2002", name: "Newer" }]),
    ).toMatchObject({ pending: true });
    warningSent.resolve({ success: true });
    await tick;

    expect(checker.pendingRestart).toBe(true);
    expect(ticks).toHaveLength(2);
    expect(restartsTriggered(checker)).toBe(0);
  });
});

// Round 3 review (ADV-3): every launch was compared with whichever server
// was active at that moment, not the one the update was found for.
describe("GH #189: the server the update was found for", () => {
  it("making another server active and starting it doesn't cancel this one's restart", async () => {
    const { checker } = makeChecker();
    await checker.handleModUpdate([MOD]);

    db.active = { id: "s2", name: "Two" };
    expect(await checker.noteServerLaunched(await launch("s2"))).toBe(false);
    expect(checker.pendingRestart).toBe(true);

    // A start of the server it was found for still does.
    expect(await checker.noteServerLaunched(await launch("s1"))).toBe(true);
    expect(checker.pendingRestart).toBe(false);
  });
});

describe("GH #189: a newer update after the manual restart arms a new restart", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gh189-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeAcf(acfPath, localTime) {
    fs.writeFileSync(
      acfPath,
      `"AppWorkshop"
{
	"appid"		"108600"
	"WorkshopItemsInstalled"
	{
		"${MOD.workshopId}"
		{
			"size"		"1234"
			"timeupdated"		"${localTime}"
		}
	}
	"WorkshopItemDetails"
	{
		"${MOD.workshopId}"
		{
			"timeupdated"		"${localTime}"
			"latest_timeupdated"		"${localTime}"
		}
	}
}
`,
    );
  }

  it("the same version doesn't re-arm after the cancel; a newer one does", async () => {
    const { checker } = makeChecker();
    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    writeAcf(acfPath, 1000);
    checker.workshopAcfPath = acfPath;
    let steamTime = 2000;
    checker.fetchSteamTimestamps = vi.fn(
      async () => new Map([[MOD.workshopId, { time_updated: steamTime, title: MOD.name }]]),
    );
    const handleModUpdate = vi.spyOn(checker, "handleModUpdate");
    checker.onUpdateCallback = (mods) => checker.handleModUpdate(mods);

    await checker.checkForUpdates();
    expect(handleModUpdate).toHaveBeenCalledTimes(1);
    expect(checker.pendingRestart).toBe(true);

    expect(await checker.noteServerLaunched(await launch())).toBe(true);

    // A check before the new server's download shows up in the ACF: the
    // version it loaded must not arm a second restart.
    await checker.checkForUpdates();
    expect(handleModUpdate).toHaveBeenCalledTimes(1);
    expect(checker.pendingRestart).toBe(false);

    // The mod author publishes again.
    steamTime = 3000;
    await checker.checkForUpdates();
    expect(handleModUpdate).toHaveBeenCalledTimes(2);
    expect(checker.pendingRestart).toBe(true);
    expect(ticks).toHaveLength(2);

    // That one waits for its own start: the earlier launch doesn't count.
    expect(await checker.noteServerLaunched({ serverId: "s1", launchSeq: 0 })).toBe(false);
    expect(checker.pendingRestart).toBe(true);
  });
});

describe("resolveActiveServerStartedAt: the start time the waiting loop compares", () => {
  const STARTED = "2026-10-02T10:00:00.000Z";

  function dockerClient(container) {
    return {
      enabled: true,
      available: true,
      inspectManagedContainer: vi.fn(async () => container),
    };
  }

  it("a native server: the process start time serverManager resolves, and its PID", async () => {
    const scan = (details) => ({
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false, ...details })),
      resolveStartTime: vi.fn(async () => new Date(STARTED)),
    });
    expect(await resolveActiveServerStartedAt(scan({ matched: [{ pid: "4242" }] }))).toEqual({
      serverId: "s1",
      startedAtMs: Date.parse(STARTED),
      processKey: "pid:4242",
    });
    // A systemd/OpenRC unit: the service manager's own record of it.
    expect(await resolveActiveServerStartedAt(scan({ mainPid: "777" }))).toMatchObject({
      processKey: "pid:777",
    });
    // No PID to name the run by.
    expect(await resolveActiveServerStartedAt(scan({}))).toMatchObject({ processKey: null });
  });

  it("a Docker server: the container's own StartedAt, which also names the run", async () => {
    db.active = { id: "s1", dockerContainerName: "pz" };
    const client = dockerClient({ State: { Running: true, StartedAt: STARTED } });
    expect(await resolveActiveServerStartedAt(null, client)).toEqual({
      serverId: "s1",
      startedAtMs: Date.parse(STARTED),
      processKey: `container:${STARTED}`,
    });
  });

  it("unknown whenever it can't be stated: stopped, failed scan, remote, no OS answer", async () => {
    const scan = (details, startTime = new Date(STARTED)) => ({
      getServerProcessDetails: vi.fn(async () => details),
      resolveStartTime: vi.fn(async () => startTime),
    });
    expect(await resolveActiveServerStartedAt(scan({ running: false, scanFailed: false }))).toBeNull();
    expect(await resolveActiveServerStartedAt(scan({ running: false, scanFailed: true }))).toBeNull();
    expect(await resolveActiveServerStartedAt(scan({ running: true, scanFailed: false }, null))).toBeNull();

    db.active = { id: "s1", dockerContainerName: "pz" };
    expect(await resolveActiveServerStartedAt(null, dockerClient({ State: { Running: false } }))).toBeNull();
    expect(await resolveActiveServerStartedAt(null, dockerClient(null))).toBeNull();

    db.active = { id: "s1", isRemote: true };
    expect(await resolveActiveServerStartedAt(scan({ running: true, scanFailed: false }))).toBeNull();
  });
});
