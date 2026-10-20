import { describe, expect, it } from "vitest";

// Security audit 2026-10-20: player_stats got a row for every distinct name
// that ever connected, kept forever, and every connect scanned all of them.
// A client joining under endless made-up names grew db.json (rewritten whole
// on every write) without bound. Each server now keeps at most
// PLAYER_STATS_LIMITS.maxRowsPerServer rows, dropping the ones seen longest
// ago -- never an online player's, and noted players' last.
//
// Real, unmocked database/init.js: vitest.perFileDataDir.setup.mjs gives
// this file its own throwaway data folder.

const {
  createServer,
  setActiveServer,
  recordPlayerSession,
  getPlayerStats,
  getPlayerStat,
  upsertPlayerNote,
  PLAYER_STATS_LIMITS,
} = await import("../database/init.js");

const CAP = PLAYER_STATS_LIMITS.maxRowsPerServer;

const rowsOf = async (serverId) =>
  (await getPlayerStats()).filter((row) => (row.server_id ?? null) === serverId);

describe("player_stats: a per-server cap", () => {
  it("is 5,000 rows", () => {
    expect(CAP).toBe(5000);
  });

  it("drops the longest-unseen offline player to make room, keeping online and noted players", async () => {
    const a = await createServer({ name: "Cap A", serverName: "CapA" });
    const b = await createServer({ name: "Cap B", serverName: "CapB" });
    await setActiveServer(b.id);
    await recordPlayerSession("OnB", "connect");
    await recordPlayerSession("OnB", "disconnect");
    await setActiveServer(a.id);

    await recordPlayerSession("Online", "connect"); // still connected
    await recordPlayerSession("Noted", "connect");
    await recordPlayerSession("Noted", "disconnect");
    await upsertPlayerNote("noted", "Griefed the mall", []);
    for (let i = 0; i < CAP - 2; i++) {
      await recordPlayerSession(`Flood${i}`, "connect");
      await recordPlayerSession(`Flood${i}`, "disconnect");
    }
    expect(await rowsOf(a.id)).toHaveLength(CAP);

    // Online and Noted are the longest unseen, then Flood0.
    for (const row of await rowsOf(a.id)) {
      if (row.player_name === "Online" || row.player_name === "Noted") row.last_seen = "2000-01-01T00:00:00.000Z";
      if (row.player_name === "Flood0") row.last_seen = "2001-01-01T00:00:00.000Z";
    }

    // A returning player takes no new row and evicts nothing.
    const flood1 = await getPlayerStat("FLOOD1", a.id);
    await recordPlayerSession("flood1", "connect");
    expect(await getPlayerStat("Flood1", a.id)).toBe(flood1);
    expect(flood1.session_count).toBe(2);
    expect(await rowsOf(a.id)).toHaveLength(CAP);

    await recordPlayerSession("Newcomer", "connect");
    const names = new Set((await rowsOf(a.id)).map((row) => row.player_name));
    expect(names.size).toBe(CAP);
    expect(names.has("Newcomer")).toBe(true);
    expect(names.has("Flood0")).toBe(false);
    expect(names.has("Online")).toBe(true);
    expect(names.has("Noted")).toBe(true);

    // Another server's rows are its own.
    expect((await rowsOf(b.id)).map((row) => row.player_name)).toEqual(["OnB"]);

    // The evicted player is simply new again when they come back.
    await recordPlayerSession("Flood0", "connect");
    expect((await getPlayerStat("Flood0", a.id)).session_count).toBe(1);
    expect(await rowsOf(a.id)).toHaveLength(CAP);
  });

  // Adversary pass: a flood of fresh names is the newest-seen, so plain
  // least-recently-seen eviction would push the regulars out first.
  it("makes room among players with under an hour of playtime before touching a regular", async () => {
    const d = await createServer({ name: "Cap D", serverName: "CapD" });
    await setActiveServer(d.id);
    await recordPlayerSession("Regular", "connect");
    await recordPlayerSession("Regular", "disconnect");
    const regular = await getPlayerStat("Regular", d.id);
    regular.total_playtime_seconds = 50 * 3600;
    regular.last_seen = "2000-01-01T00:00:00.000Z"; // not seen for ages
    for (let i = 0; i < CAP + 50; i++) {
      await recordPlayerSession(`Bot${i}`, "connect");
      await recordPlayerSession(`Bot${i}`, "disconnect");
    }
    const names = new Set((await rowsOf(d.id)).map((row) => row.player_name));
    expect(names.size).toBe(CAP);
    expect(names.has("Regular")).toBe(true);
    expect(names.has("Bot0")).toBe(false);
    expect(names.has(`Bot${CAP + 49}`)).toBe(true);
  });

  it("brings a server that is already over the cap (rows from before the fix) back under it in one go", async () => {
    const c = await createServer({ name: "Cap C", serverName: "CapC" });
    await setActiveServer(c.id);
    const rows = await getPlayerStats(); // the live array
    for (let i = 0; i < CAP + 1000; i++) {
      rows.push({
        id: `legacy-${i}`,
        player_name: `Old${i}`,
        server_id: c.id,
        total_playtime_seconds: 0,
        session_count: 1,
        first_seen: "2020-01-01T00:00:00.000Z",
        last_seen: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
        last_session_start: null,
        sessions: [],
      });
    }

    const started = performance.now();
    await recordPlayerSession("Fresh", "connect");
    expect(performance.now() - started).toBeLessThan(2000);

    const kept = await rowsOf(c.id);
    expect(kept).toHaveLength(CAP);
    const names = new Set(kept.map((row) => row.player_name));
    expect(names.has("Fresh")).toBe(true);
    expect(names.has("Old0")).toBe(false); // seen longest ago
    expect(names.has(`Old${CAP + 999}`)).toBe(true); // seen most recently
  });
});
