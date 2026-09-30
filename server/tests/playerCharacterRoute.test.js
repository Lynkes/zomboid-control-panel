import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "characterSheetB2.json"), "utf8"));

const getActiveServer = vi.fn();
const getPlayerLogs = vi.fn();
const getRoleByName = vi.fn();

vi.mock("../database/init.js", () => ({
  getRoleByName: (...args) => getRoleByName(...args),
  getActiveServer: (...args) => getActiveServer(...args),
  getPlayerLogs: (...args) => getPlayerLogs(...args),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router, resetPlayerCharacterRouteState } = await import("../routes/playerCharacter.js");
const { getDataPaths } = await import("../utils/paths.js");

// A fresh server id per test keeps each test's saved records apart (the data
// dir is shared across this file).
let SERVER_ID;
let serverCounter = 0;

function routeStack() {
  const layer = router.stack.find((entry) => entry.route?.path === "/:username" && entry.route.methods.get);
  return layer.route.stack.map((s) => s.handle);
}

// Runs the real middleware chain (the requirePermission gate, then the
// handler) the way Express would.
async function request({ username = "Kate", query = {}, role = "moderator", user } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const req = { params: { username }, query, user: user === undefined ? (role ? { role } : undefined) : user };
  const handlers = routeStack();
  let index = 0;
  const next = async () => {
    const handler = handlers[index++];
    if (handler) await handler(req, res, next);
  };
  await next();
  return res;
}

let sendCommand;
let actions;

function onAction(action, impl) {
  actions[action] = impl;
}

beforeEach(() => {
  serverCounter += 1;
  SERVER_ID = `8d1c2c1e-4a6b-4d2e-9a61-${String(serverCounter).padStart(12, "0")}`;
  resetPlayerCharacterRouteState();
  getRoleByName.mockImplementation(async (name) =>
    name === "custom" ? { name: "custom", capabilities: ["players.gm_tools"] } : mockGetRoleByName(name),
  );
  getActiveServer.mockResolvedValue({ id: SERVER_ID, name: "Test" });
  getPlayerLogs.mockResolvedValue([]);
  bridge.isRunning = true;
  bridge.modStatus = { alive: true, players: ["Kate"] };
  bridge.sftpTransport = null;
  actions = {
    getCharacterSheet: async () => ({ success: true, data: fixture }),
    getLeaderboard: async () => ({
      success: true,
      data: {
        players: [
          { username: "kate", allTimeKills: 900, deaths: 3, bestDays: 41, currentKills: 214, currentDays: 13, favoriteWeapon: "Axe" },
        ],
      },
    }),
  };
  sendCommand = vi.spyOn(bridge, "sendCommand").mockImplementation(async (action, args) => {
    const impl = actions[action];
    if (!impl) throw new Error(`Unexpected action ${action}`);
    return impl(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  bridge.isRunning = false;
  bridge.modStatus = null;
});

function sheetCalls() {
  return sendCommand.mock.calls.filter(([action]) => action === "getCharacterSheet");
}

describe("GET /api/player-character/:username -- gate and validation", () => {
  it("401 without a session, 403 for a role without players.view", async () => {
    expect((await request({ user: null })).statusCode).toBe(401);
    const denied = await request({ role: "custom" });
    expect(denied.statusCode).toBe(403);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("200 for a moderator (players.view)", async () => {
    const res = await request({ role: "moderator" });
    expect(res.statusCode).toBe(200);
    expect(res.body.availability).toBe("live");
  });

  it("400 BRIDGE_INVALID_USERNAME_FORMAT for a name the bridge would refuse", async () => {
    for (const username of ['Ka"te', "Ka\\te", " ", "x".repeat(65), "a\u0001"]) {
      const res = await request({ username });
      expect(res.statusCode, JSON.stringify(username)).toBe(400);
      expect(res.body.code).toBe("BRIDGE_INVALID_USERNAME_FORMAT");
    }
  });

  it("400 CHARACTER_INVALID_SECTIONS for an unknown or empty section list", async () => {
    for (const sections of ["summary,passwords", "", "inventory,", ["summary"]]) {
      const res = await request({ query: { sections } });
      expect(res.statusCode, JSON.stringify(sections)).toBe(400);
      expect(res.body.code).toBe("CHARACTER_INVALID_SECTIONS");
    }
  });

  it("500 CHARACTER_SHEET_FAILED without the raw error", async () => {
    getActiveServer.mockRejectedValue(new Error("EACCES: /var/lib/secret/db.json"));
    const res = await request();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Couldn't read this character.", code: "CHARACTER_SHEET_FAILED" });
  });
});

describe("GET /api/player-character/:username -- response", () => {
  it("returns the full live shape with the leaderboard record merged in", async () => {
    const res = await request({ query: { sections: "skills,summary" } });
    expect(sheetCalls()[0][1]).toEqual({ username: "Kate", sections: ["summary", "skills"] });
    expect(res.body).toMatchObject({
      username: "Kate",
      serverId: SERVER_ID,
      availability: "live",
      transport: "local",
      refreshAfterMs: 10000,
      inventoryRefreshAfterMs: 30000,
      cached: null,
      record: { allTimeKills: 900, deaths: 3, bestDays: 41, currentKills: 214, currentDays: 13, favoriteWeapon: "Axe" },
      skillDelta: null,
      hints: [],
      hintSource: "live",
      cost: { ms: 4, walked: 7 },
    });
    expect(res.body.hintThresholds.unusualQuantity).toBe(500);
    expect(typeof res.body.fetchedAt).toBe("string");
    expect(res.body.sheet.skills.perks.length).toBeGreaterThan(0);
  });

  it("slower refresh over SFTP", async () => {
    bridge.sftpTransport = { getStatus: () => ({ type: "sftp" }) };
    const res = await request();
    expect(res.body).toMatchObject({ transport: "sftp", refreshAfterMs: 30000, inventoryRefreshAfterMs: 60000 });
  });

  it("bridgeOffline serves the last saved sheet, with hints marked cached", async () => {
    const withMug = structuredClone(fixture);
    withMug.inventory.root.rows.push({ kind: "stack", fullType: "Base.TestMug", name: "Mug", qty: 1 });
    onAction("getCharacterSheet", async () => ({ success: true, data: withMug }));
    await request({ query: { sections: "summary,stats,skills,traits,inventory" } });

    bridge.modStatus = { alive: false };
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body.availability).toBe("bridgeOffline");
    expect(res.body.sheet).toBeNull();
    expect(res.body.record).toBeNull();
    expect(res.body.cached.sheet.username).toBe("Kate");
    expect(res.body.cached.inventoryAt).toEqual(expect.any(String));
    expect(res.body.hintSource).toBe("cached");
    expect(res.body.hints.map((h) => [h.id, h.source])).toEqual([["debugItems", "cached"]]);
  });

  it("bridgeOffline with nothing saved is an empty but complete response", async () => {
    bridge.isRunning = false;
    const res = await request({ username: "Nobody" });
    expect(res.body).toMatchObject({
      availability: "bridgeOffline",
      transport: null,
      sheet: null,
      cached: null,
      hints: [],
      hintSource: null,
    });
  });

  it("partial on an old bridge: condition from getPlayerDetails", async () => {
    onAction("getCharacterSheet", async () => {
      throw new Error("Unknown command: getCharacterSheet");
    });
    onAction("getPlayerDetails", async () => ({
      success: true,
      data: { username: "Kate", accessLevel: "none", stats: { hunger: 0.5 }, health: { overallBodyHealth: 70 } },
    }));
    const res = await request();
    expect(res.body.availability).toBe("partial");
    expect(res.body.sheet.stats).toEqual({ hunger: { value: 0.5 } });
    expect(res.body.sheet.health).toEqual({ overall: 70 });
  });

  it.each([
    ["Player not found: Kate", "playerOffline"],
    ["Command timeout: getCharacterSheet (no response from mod)", "timeout"],
    ["Online player list unavailable", "bridgeOffline"],
  ])("maps %j to %s", async (message, availability) => {
    onAction("getCharacterSheet", async () => {
      throw new Error(message);
    });
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body.availability).toBe(availability);
    expect(res.body.sheet).toBeNull();
  });

  it("playerOffline shows the login snapshot's skills when the player was read before", async () => {
    await request();
    onAction("getCharacterSheet", async () => {
      throw new Error("Player not found: Kate");
    });
    // Past the 2 s coalescing window.
    resetPlayerCharacterRouteState();
    const res = await request();
    expect(res.body.availability).toBe("playerOffline");
    expect(res.body.cached.sheet.skills.perks.length).toBeGreaterThan(0);
    // The leaderboard still knows an offline player.
    expect(res.body.record.allTimeKills).toBe(900);
  });

  it("never emits a file path", async () => {
    await request({ query: { sections: "summary,stats,skills,traits,inventory" } });
    bridge.modStatus = { alive: false };
    const offline = await request();
    const live = await (async () => {
      bridge.modStatus = { alive: true };
      resetPlayerCharacterRouteState();
      return request();
    })();
    const { dataDir } = getDataPaths();
    for (const body of [offline.body, live.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(dataDir);
      expect(text).not.toContain(dataDir.replace(/\\/g, "\\\\"));
      expect(text).not.toContain("character-sheets");
      expect(text).not.toMatch(/[A-Za-z]:\\\\|\/(home|var|etc|usr|tmp)\//);
    }
  });
});

describe("GET /api/player-character/:username -- coalescing and fresh", () => {
  it("identical concurrent requests share one bridge read", async () => {
    let release;
    onAction("getCharacterSheet", () => new Promise((resolve) => (release = () => resolve({ success: true, data: fixture }))));
    const first = request();
    const second = request({ username: "KATE" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(sheetCalls()).toHaveLength(1);
    expect(a.body.availability).toBe("live");
    expect(b.body).toBe(a.body);
  });

  it("reuses an answer for 2 s, then reads again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-29T12:00:00.000Z"));
    await request();
    await request();
    expect(sheetCalls()).toHaveLength(1);
    vi.setSystemTime(Date.parse("2026-09-29T12:00:02.500Z"));
    await request();
    expect(sheetCalls()).toHaveLength(2);
  });

  it("different sections don't share a read", async () => {
    await request();
    await request({ query: { sections: "inventory" } });
    expect(sheetCalls().map(([, args]) => args.sections)).toEqual([
      ["summary", "stats", "skills", "traits"],
      ["inventory"],
    ]);
  });

  it("honours fresh=1 once per player per 5 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-29T12:00:00.000Z"));
    await request({ query: { fresh: "1" } });
    vi.setSystemTime(Date.parse("2026-09-29T12:00:03.000Z"));
    await request({ query: { fresh: "1" } });
    vi.setSystemTime(Date.parse("2026-09-29T12:00:05.500Z"));
    await request({ query: { fresh: "1" } });
    expect(sheetCalls().map(([, args]) => args.fresh === true)).toEqual([true, false, true]);
  });

  it("passes a clamped maxItems", async () => {
    await request({ query: { sections: "inventory", maxItems: "5000" } });
    expect(sheetCalls()[0][1].maxItems).toBe(1000);
  });
});

describe("GET /api/player-character/:username -- hints and history", () => {
  it("a panel Give item explains a debug item; add_xp explains a skill jump", async () => {
    const now = Date.now();
    getPlayerLogs.mockResolvedValue([
      { action: "add_item", details: "Base.TestMug x1", logged_at: new Date(now - 60 * 1000).toISOString(), player_name: "Kate" },
    ]);
    const withMug = structuredClone(fixture);
    withMug.inventory.root.rows.push({ kind: "stack", fullType: "Base.TestMug", name: "Mug", qty: 1 });
    onAction("getCharacterSheet", async () => ({ success: true, data: withMug }));
    const res = await request({ query: { sections: "summary,stats,skills,traits,inventory" } });
    expect(getPlayerLogs).toHaveBeenCalledWith("Kate", 200, SERVER_ID);
    const mug = res.body.hints.find((h) => h.id === "debugItems");
    expect(mug.explainedBy).toEqual([expect.objectContaining({ action: "add_item", details: "Base.TestMug x1" })]);
  });

  it("returns a skill delta against the saved history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-29T12:00:00.000Z"));
    await request();
    const levelled = structuredClone(fixture);
    levelled.skills.perks.find((p) => p.id === "Axe").level = 6;
    onAction("getCharacterSheet", async () => ({ success: true, data: levelled }));
    vi.setSystemTime(Date.parse("2026-09-29T12:20:00.000Z"));
    const res = await request();
    expect(res.body.skillDelta).toMatchObject({
      since: "2026-09-29T12:00:00.000Z",
      source: "view",
      perks: [{ id: "Axe", fromLevel: 2, toLevel: 6 }],
    });
    expect(res.body.hints.map((h) => h.id)).toContain("skillJump");
  });
});
