import { describe, expect, it, beforeEach } from "vitest";

// continuous-bug-hunt round 21 (other per-server data kept in one global
// store): round 20 found performance_history was a single global array
// with no server identity -- god asked for the SAME check across every
// server-side in-memory cache, JSON store and DB table holding per-server
// data. This file covers every collection that store audit found genuinely
// missing a server_id and got fixed the same additive way (tag at write,
// optional-filter at read, tolerant of pre-fix untagged rows): command
// history, player action logs, server events, schedule history, bridge
// (PanelBridge) logs, and SteamID bans.
//
// SAFETY, load-bearing: REAL, UNMOCKED database/init.js -- the bug and fix
// are both in that module's own tagging/filtering logic, so mocking it
// would make this meaningless. Safe only because
// server/tests/vitest.perFileDataDir.setup.mjs mints a fresh, throwaway
// temp dataDir before this file's module graph is ever imported -- same
// convention as debugDatabaseRoutesRealExecution.test.js and round 20's
// own performanceHistoryServerScoping.test.js.

const {
  createServer,
  setActiveServer,
  logCommand,
  getCommandHistory,
  logPlayerAction,
  getPlayerLogs,
  logServerEvent,
  getServerEvents,
  logScheduleExecution,
  getScheduleHistory,
  logBridgeCommand,
  getBridgeLogs,
  getSteamIdBans,
  addSteamIdBan,
  removeSteamIdBan,
} = await import("../database/init.js");

async function makeTwoServers() {
  const a = await createServer({ name: "Server A", serverName: "ServerA" });
  const b = await createServer({ name: "Server B", serverName: "ServerB" });
  await setActiveServer(a.id);
  return { a, b };
}

describe("Command history: RCON commands scoped to the server that was active when they ran", () => {
  it("keeps server A's and server B's commands separate", async () => {
    const { a, b } = await makeTwoServers();

    await logCommand("players", "0 players", true); // active = A
    await setActiveServer(b.id);
    await logCommand("save", "saved", true); // active = B

    const historyA = await getCommandHistory(100, a.id);
    expect(historyA.map((e) => e.command)).toEqual(["players"]);

    const historyB = await getCommandHistory(100, b.id);
    expect(historyB.map((e) => e.command)).toEqual(["save"]);

    // Unfiltered (existing callers, e.g. the support-bundle export) still see both.
    expect((await getCommandHistory(100)).length).toBe(2);
  });

  // continuous-bug-hunt round 22 (closing round 21's own named limitation):
  // a scheduled task's throwaway RconService instance (targeting a server
  // OTHER than the active one) now passes its own resolved this.serverId
  // explicitly -- proving THAT argument, not just the getActiveServerId()
  // default, actually wins.
  it("an explicit serverId argument (a scheduled task's real target) wins over whatever server is active", async () => {
    const { a, b } = await makeTwoServers();
    // Active server is A, but the command explicitly targets B -- the
    // exact shape of a scheduled task pinned to a non-active server.
    await logCommand("players", "1 player", true, b.id);

    const historyA = await getCommandHistory(100, a.id);
    expect(historyA).toEqual([]);

    const historyB = await getCommandHistory(100, b.id);
    expect(historyB.map((e) => e.command)).toEqual(["players"]);
  });
});

describe("Player action logs: moderation history scoped per server", () => {
  it("keeps server A's and server B's kicks/bans separate", async () => {
    const { a, b } = await makeTwoServers();

    await logPlayerAction("Alice", "kick", "spamming");
    await setActiveServer(b.id);
    await logPlayerAction("Bob", "ban", "griefing");

    const logsA = await getPlayerLogs(null, 100, a.id);
    expect(logsA.map((e) => e.player_name)).toEqual(["Alice"]);

    const logsB = await getPlayerLogs(null, 100, b.id);
    expect(logsB.map((e) => e.player_name)).toEqual(["Bob"]);
  });
});

describe("Server events: scoped per server", () => {
  it("keeps server A's and server B's events separate", async () => {
    const { a, b } = await makeTwoServers();

    await logServerEvent("auto_restart", "Server A restarted");
    await setActiveServer(b.id);
    await logServerEvent("auto_restart_error", "Server B failed to restart");

    const eventsA = await getServerEvents(100, a.id);
    expect(eventsA.map((e) => e.event_type)).toEqual(["auto_restart"]);

    const eventsB = await getServerEvents(100, b.id);
    expect(eventsB.map((e) => e.event_type)).toEqual(["auto_restart_error"]);
  });
});

describe("Schedule history: auto-restart/backup entries (taskId=null) scoped to the active server", () => {
  it("keeps server A's and server B's auto-restart history separate", async () => {
    const { a, b } = await makeTwoServers();

    await logScheduleExecution(null, "Auto Restart", "restart", true, "ok on A", 100);
    await setActiveServer(b.id);
    await logScheduleExecution(null, "Auto Restart", "restart", false, "failed on B", 200);

    const historyA = await getScheduleHistory(100, null, a.id);
    expect(historyA.map((e) => e.message)).toEqual(["ok on A"]);

    const historyB = await getScheduleHistory(100, null, b.id);
    expect(historyB.map((e) => e.message)).toEqual(["failed on B"]);
  });
});

describe("Bridge (PanelBridge) logs: scoped per server", () => {
  it("keeps server A's and server B's bridge commands separate", async () => {
    const { a, b } = await makeTwoServers();

    await logBridgeCommand("getStatus", {}, { ok: true }, true, 5);
    await setActiveServer(b.id);
    await logBridgeCommand("teleport", { x: 1 }, { ok: true }, true, 8);

    const logsA = await getBridgeLogs(100, a.id);
    expect(logsA.map((e) => e.action)).toEqual(["getStatus"]);

    const logsB = await getBridgeLogs(100, b.id);
    expect(logsB.map((e) => e.action)).toEqual(["teleport"]);
  });

  // continuous-bug-hunt round 22: same optional-override contract as
  // logCommand() above, added for symmetry -- no reachable caller passes
  // this today (PanelBridge has no per-server instancing, see this
  // function's own comment in database/init.js), but the function itself
  // must honor an explicit override correctly regardless.
  it("an explicit serverId argument wins over whatever server is active", async () => {
    const { a, b } = await makeTwoServers();
    await logBridgeCommand("getStatus", {}, { ok: true }, true, 5, b.id);

    expect((await getBridgeLogs(100, a.id))).toEqual([]);
    expect((await getBridgeLogs(100, b.id)).map((e) => e.action)).toEqual(["getStatus"]);
  });
});

describe("SteamID bans: the SAME SteamID can be banned on one server and not another", () => {
  it("banning a SteamID on server B does not silently no-op just because it's already banned on server A", async () => {
    const { a, b } = await makeTwoServers();
    const steamId = "76561198000000001";

    await addSteamIdBan(steamId, "griefing on A");
    const bansAAfterFirst = await getSteamIdBans();
    expect(bansAAfterFirst.map((b) => b.steamId)).toEqual([steamId]);

    await setActiveServer(b.id);
    // The bug: a global dedup check on steamId alone would silently skip
    // this add, since the same steamId "already exists" (on server A).
    await addSteamIdBan(steamId, "griefing on B");

    const bansB = await getSteamIdBans();
    expect(bansB).toHaveLength(1);
    expect(bansB[0].reason).toBe("griefing on B");

    await setActiveServer(a.id);
    const bansA = await getSteamIdBans();
    expect(bansA).toHaveLength(1);
    expect(bansA[0].reason).toBe("griefing on A");
  });

  it("removing a SteamID ban on server A does not remove server B's own ban of the same SteamID", async () => {
    const { a, b } = await makeTwoServers();
    const steamId = "76561198000000002";

    await addSteamIdBan(steamId, "on A");
    await setActiveServer(b.id);
    await addSteamIdBan(steamId, "on B");

    await setActiveServer(a.id);
    const removed = await removeSteamIdBan(steamId);
    expect(removed).toBe(true);
    expect(await getSteamIdBans()).toEqual([]);

    await setActiveServer(b.id);
    const bansB = await getSteamIdBans();
    expect(bansB).toHaveLength(1);
    expect(bansB[0].reason).toBe("on B");
  });
});
