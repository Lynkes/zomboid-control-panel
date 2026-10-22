import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createRoot, createServerFiles, makeServer, MOD, WS_ID } from "./helpers/bridgeDeliveryFixtures.js";

// Supply-chain review 2026-10-20: a Workshop server runs whatever Lua the
// PanelBridge item holds, and nothing compared it with what was published.
// published.json now records the sha256 of the published PanelBridge.lua
// (scripts/workshop/publish.mjs writes it), and the delivery status checks a
// server's download against it: a warning, never a block.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));
vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  return dbMockImplementation(dbState);
});
vi.mock("../utils/serverStatus.js", () => ({ resolveObservedServerRunning: vi.fn(async () => true) }));

const { checkWorkshopItemServerLua, detectWorkshopItem } = await import("../services/bridgeDisk.js");
const { getDeliveryStatus } = await import("../services/bridgeDelivery.js");
const { _resetWorkshopReleaseCacheForTests, getWorkshopRelease } = await import("../services/bridgeWorkshopRelease.js");

const PUBLISHED_LUA = "if not (isServer and isServer()) then return end\n-- PanelBridge 1.7.76\n";
const PUBLISHED_SHA = crypto.createHash("sha256").update(PUBLISHED_LUA).digest("hex");
const VERSION = "1.7.76";

let root;
let files;

// A downloaded item laid out as build-item.mjs builds it: 42/mod.info and
// common/media/lua/{server,client}.
function makeItem(folder, { version = VERSION, serverLua = PUBLISHED_LUA } = {}) {
  const mod = path.join(folder, "mods", MOD);
  fs.mkdirSync(path.join(mod, "42"), { recursive: true });
  fs.writeFileSync(path.join(mod, "42", "mod.info"), `name=Zomboid Control Panel Bridge\nid=${MOD}\nmodversion=${version}\n`);
  if (serverLua !== null) put(mod, "common/media/lua/server/PanelBridge.lua", serverLua);
  put(mod, "common/media/lua/client/PanelBridgeClient.lua", "if not (isClient and isClient()) then return end\n");
  return mod;
}

function put(base, relative, content) {
  const full = path.join(base, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function itemFolder() {
  return path.join(files.installDir, "steamapps", "workshop", "content", "108600", WS_ID);
}

const check = (folder, expected = {}) =>
  checkWorkshopItemServerLua(detectWorkshopItem(files.installDir, WS_ID) ?? { folder, version: VERSION }, {
    expectedSha256: PUBLISHED_SHA,
    expectedVersion: VERSION,
    ...expected,
  });

function publishedDoc(overrides = {}) {
  return JSON.stringify({
    schema: 1,
    modId: MOD,
    workshopId: WS_ID,
    visibility: "unlisted",
    publishedVersion: VERSION,
    serverLuaSha256: PUBLISHED_SHA,
    publishedAt: "2026-10-13T13:05:18.071Z",
    liveVerified: { windowsServer: null, linuxServer: null },
    ...overrides,
  });
}

beforeEach(() => {
  root = createRoot("bridge-integrity-");
  files = createServerFiles(root);
  dbState.servers = [];
  dbState.settings = {};
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "");
  vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", publishedDoc());
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkWorkshopItemServerLua", () => {
  it("verifies an item whose PanelBridge.lua is the published file", () => {
    makeItem(itemFolder());
    expect(check()).toEqual({ integrity: "verified", serverLuaSha256: PUBLISHED_SHA });
  });

  it("flags an item whose PanelBridge.lua differs, even by one byte", () => {
    makeItem(itemFolder(), { serverLua: `${PUBLISHED_LUA} ` });
    expect(check()).toMatchObject({ integrity: "mismatch" });
    expect(check().serverLuaSha256).not.toBe(PUBLISHED_SHA);
  });

  it("flags an item that lost its PanelBridge.lua", () => {
    makeItem(itemFolder(), { serverLua: null });
    expect(check()).toMatchObject({ integrity: "mismatch", serverLuaSha256: null });
  });

  it("checks only the version the checksum was recorded for, and nothing without one", () => {
    makeItem(itemFolder(), { version: "1.7.77", serverLua: "-- a later release\n" });
    expect(check()).toEqual({ integrity: "unverified", serverLuaSha256: null });
    makeItem(itemFolder(), { serverLua: "-- anything\n" });
    expect(check(undefined, { expectedSha256: null })).toEqual({ integrity: "unverified", serverLuaSha256: null });
    expect(check(undefined, { expectedVersion: null })).toEqual({ integrity: "unverified", serverLuaSha256: null });
  });

  // Adversary pass: keep PanelBridge.lua pristine and run other code.
  it.each([
    ["another server Lua beside it", "common/media/lua/server/Extra.lua"],
    ["a shared Lua (the server runs shared/ too)", "common/media/lua/shared/Init.lua"],
    ["a nested shared Lua", "common/media/lua/shared/a/b/c.lua"],
    ["a server Lua in the version folder", "42/media/lua/server/Extra.lua"],
    ["a version folder's own PanelBridge.lua (it overrides common/)", "42/media/lua/server/PanelBridge.lua"],
    ["a differently-cased folder (Windows reads it the same)", "common/Media/LUA/Server/Evil.lua"],
    ["a differently-cased copy (Linux loads both)", "common/media/lua/server/panelbridge.lua"],
    ["a numbered version folder", "42.21/media/lua/server/PanelBridge.lua"],
  ])("flags %s", (_label, relative) => {
    const mod = makeItem(itemFolder());
    put(mod, relative, "print('not the published bridge')\n");
    expect(check()).toMatchObject({ integrity: "mismatch" });
  });

  it("ignores client Lua and files outside the layers the game loads", () => {
    const mod = makeItem(itemFolder());
    put(mod, "common/media/lua/client/Extra.lua", "-- client only\n");
    put(mod, "notalayer/media/lua/server/Extra.lua", "-- never loaded\n");
    put(mod, "common/media/lua/server/readme.txt", "not Lua\n");
    expect(check()).toMatchObject({ integrity: "verified" });
  });

  it("flags a tree too deep to check completely", () => {
    const mod = makeItem(itemFolder());
    put(mod, `common/media/lua/shared/${"d/".repeat(12)}x.lua`, "-- deep\n");
    expect(check()).toMatchObject({ integrity: "mismatch" });
  });

  it("leaves detectWorkshopItem's own answer unchanged", () => {
    makeItem(itemFolder());
    expect(detectWorkshopItem(files.installDir, WS_ID)).toEqual({ folder: itemFolder(), version: VERSION, source: "candidate" });
  });
});

describe("published.json's checksum in the release", () => {
  it("is read from the document", () => {
    expect(getWorkshopRelease()).toMatchObject({ status: "published", publishedVersion: VERSION, serverLuaSha256: PUBLISHED_SHA });
  });

  it.each([["upper case", PUBLISHED_SHA.toUpperCase()], ["too short", "abc"], ["a number", 42]])(
    "is dropped, not fatal, when malformed (%s)",
    (_label, value) => {
      vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", publishedDoc({ serverLuaSha256: value }));
      _resetWorkshopReleaseCacheForTests();
      expect(getWorkshopRelease()).toMatchObject({ status: "published", workshopId: WS_ID, serverLuaSha256: null });
    },
  );

  it("is never applied to the PANEL_BRIDGE_WORKSHOP_ID test item", () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "987654321");
    _resetWorkshopReleaseCacheForTests();
    expect(getWorkshopRelease()).toMatchObject({ source: "env", workshopId: "987654321", serverLuaSha256: null });
  });
});

describe("delivery status: the downloaded item's integrity", () => {
  const switched = () =>
    makeServer(files, {
      bridgeDelivery: "workshop",
      bridgeDeliverySwitch: {
        to: "workshop",
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        by: "admin",
        bridgeStartedAt: 1000,
        workshopId: WS_ID,
      },
    });
  const statusFor = async (server) => {
    dbState.servers = [server];
    return getDeliveryStatus(server, {
      serverManager: { startTime: null },
      rconService: { connected: false },
      modChecker: {},
      bridge: { getStatus: () => ({ modStatus: null }) },
    });
  };

  it("reports verified for the published file", async () => {
    makeItem(itemFolder());
    const { disk } = await statusFor(switched());
    expect(disk.workshopItem).toMatchObject({ version: VERSION, integrity: "verified", serverLuaSha256: PUBLISHED_SHA });
  });

  it("reports a mismatch without changing anything else about the status", async () => {
    makeItem(itemFolder(), { serverLua: "print('changed')\n" });
    const altered = await statusFor(switched());
    expect(altered.disk.workshopItem).toMatchObject({ integrity: "mismatch" });

    makeItem(itemFolder());
    const pristine = await statusFor(switched());
    // A warning only: state, offers and blockers are what they would be anyway.
    for (const key of ["state", "switchAvailability", "checksum"]) {
      expect(altered[key], key).toEqual(pristine[key]);
    }
  });

  it("doesn't check an item under the test override", async () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
    _resetWorkshopReleaseCacheForTests();
    makeItem(itemFolder(), { serverLua: "print('a test build')\n" });
    const { disk } = await statusFor(switched());
    expect(disk.workshopItem).toMatchObject({ integrity: "unverified" });
  });
});

// The Workshop item id decides which Lua every Workshop server downloads and
// runs. Changing it must be a deliberate, reviewed act: this test has to be
// edited alongside it. The checksum recorded for the published version is
// the one of the file Steam serves for it (checked against a real download
// of item 3809901056, PanelBridge 1.7.76, on 2026-10-20).
describe("pz-mod/workshop/published.json", () => {
  const doc = JSON.parse(fs.readFileSync(new URL("../../pz-mod/workshop/published.json", import.meta.url), "utf8"));

  it("pins the PanelBridge Workshop item", () => {
    expect(doc.workshopId).toBe("3809901056");
    expect(doc.modId).toBe("ZCPB");
  });

  it("records the published Lua's checksum (or null, which skips the check)", () => {
    expect(doc.serverLuaSha256 === null || /^[0-9a-f]{64}$/.test(doc.serverLuaSha256)).toBe(true);
    if (doc.publishedVersion === "1.7.76") {
      expect(doc.serverLuaSha256).toBe("2268a589750db5cfc6008436f497b979c9e734e930a3c592546d4f0dfab2d4c0");
    }
  });
});
