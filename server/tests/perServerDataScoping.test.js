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
  recordPlayerSession,
  getPlayerStats,
  getPlayerStat,
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

// worker-pz-playtime-per-server, 2026-09-18 (operator decision: player NOTES
// stay shared across servers, PLAYTIME does not): player_stats/its nested
// sessions were keyed by player_name alone, so the same player's playtime
// mixed together across every managed server. Fixed the same additive way
// as the six collections above, with one deliberate difference: a pre-fix
// untagged row is NEVER migrated/rewritten on touch (unlike tracked_mods/
// steamid_bans' migrate-on-touch) -- a new tagged row is started per
// (player, server) pair instead, so the untagged row keeps reading exactly
// as it did before this fix, on every server, until the player earns a
// tagged row of their own.
describe("Player playtime stats: total_playtime_seconds/sessions scoped per server", () => {
  it("keeps the same player's playtime on server A and server B separate", async () => {
    const { a, b } = await makeTwoServers();

    await recordPlayerSession("Alice", "connect");
    await recordPlayerSession("Alice", "disconnect"); // a few ms of playtime on A

    await setActiveServer(b.id);
    await recordPlayerSession("Alice", "connect");
    await recordPlayerSession("Alice", "connect"); // second B session bumps session_count to 2
    await recordPlayerSession("Alice", "disconnect");

    const statOnA = await getPlayerStat("Alice", a.id);
    const statOnB = await getPlayerStat("Alice", b.id);

    expect(statOnA.session_count).toBe(1);
    expect(statOnB.session_count).toBe(2);
    expect(statOnA).not.toBe(statOnB);

    const statsA = await getPlayerStats(a.id);
    const statsB = await getPlayerStats(b.id);
    expect(statsA.map((s) => s.player_name)).toEqual(["Alice"]);
    expect(statsB.map((s) => s.player_name)).toEqual(["Alice"]);
    expect(statsA[0].session_count).toBe(1);
    expect(statsB[0].session_count).toBe(2);

    // Unfiltered (no serverId argument) still sees every row for every server.
    const allNamed = (await getPlayerStats()).filter((s) => s.player_name === "Alice");
    expect(allNamed).toHaveLength(2);
  });

  it("a pre-fix untagged row is never rewritten, and stays readable on every server", async () => {
    const { a, b } = await makeTwoServers();

    // Simulate a real pre-fix legacy row: server_id=null, the same shape
    // this player's data had before this fix started tagging writes.
    await recordPlayerSession("Bob", "connect", null);
    await recordPlayerSession("Bob", "disconnect", null);
    const legacy = await getPlayerStat("Bob", null);
    expect(legacy.server_id).toBeNull();

    // Bob hasn't reconnected since the servers were created, so both server
    // views still fall back to his legacy figures -- read-only, not migrated.
    const onA = await getPlayerStat("Bob", a.id);
    const onB = await getPlayerStat("Bob", b.id);
    expect(onA.total_playtime_seconds).toBe(legacy.total_playtime_seconds);
    expect(onB.total_playtime_seconds).toBe(legacy.total_playtime_seconds);
    expect(onA.server_id).toBeNull();

    // Bob connects for real on server A now -- a NEW row is created for A;
    // the legacy row is untouched, and B still falls back to it.
    await recordPlayerSession("Bob", "connect");
    await recordPlayerSession("Bob", "disconnect");

    const stillLegacy = await getPlayerStat("Bob"); // unfiltered, first match = the untouched legacy row
    expect(stillLegacy.server_id).toBeNull();
    expect(stillLegacy.session_count).toBe(1);

    const freshOnA = await getPlayerStat("Bob", a.id);
    expect(freshOnA.server_id).toBe(a.id);
    expect(freshOnA.session_count).toBe(1);

    const fallbackOnB = await getPlayerStat("Bob", b.id);
    expect(fallbackOnB.server_id).toBeNull();
    expect(fallbackOnB.session_count).toBe(1);
  });
});
