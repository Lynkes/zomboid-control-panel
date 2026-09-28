import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";
import {
  MOD,
  WS_ID,
  bundledLua,
  createRoot,
  createServerFiles,
  makeServer,
  writeLoose,
} from "./helpers/bridgeDeliveryFixtures.js";

// End to end across the two halves of the PanelBridge delivery feature: the
// real PanelBridge.lua runs under fengari and writes its heartbeat; the
// panel's real PanelBridge service reads that file the way it reads a live
// server's; getDeliveryStatus derives the Settings › PanelBridge state from
// it. Each half has its own tests with hand-written stand-ins for the other
// (bridgeDeliveryStatus.test.js feeds literal modStatus objects;
// panelBridgeDeliveryDetection.test.js checks the JSON the Lua writes).
// This one proves the states that need a real bridge report --
// workshop-confirmed and local-workshop-loaded -- are reachable from what
// the Lua actually writes, field names and number formats included.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));
const runningState = vi.hoisted(() => ({ value: null }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  return dbMockImplementation(dbState);
});
vi.mock("../utils/serverStatus.js", () => ({
  resolveObservedServerRunning: vi.fn(async () => runningState.value),
}));

const { getDeliveryStatus } = await import("../services/bridgeDelivery.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");
const { PanelBridge } = await import("../services/panelBridge.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(__dirname, "..", "..", "pz-mod", "PanelBridge", "media", "lua", "server", "PanelBridge.lua");

// Enough of the engine for PanelBridge.onServerStarted() to run end to end
// (the same stand-ins panelBridgeDeliveryDetection.test.js uses): file
// writes land in FILES keyed by their Lua-relative path.
function engineStubs({ now, gameVersion }) {
  return `
FILES = {}
print = function() end
NOW = ${now}
getTimestampMs = function() return NOW end
getServerName = function() return "TestServer" end
getOnlinePlayers = function() return nil end
getWorld = function() return nil end
getSandboxOptions = function() return nil end
getGameTime = function() return nil end
getChatSystem = function() return {} end
getFileReader = function(path)
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return value
  end
  function reader:close() end
  return reader
end
getFileWriter = function(path)
  local writer = { value = "" }
  function writer:write(text) self.value = self.value .. text end
  function writer:close() FILES[path] = self.value end
  return writer
end
FakeCore = {}
function FakeCore:getVersion() return "${gameVersion}" end
getCore = function() return FakeCore end
`;
}

const WORKSHOP_FILE = `/srv/pz/steamapps/workshop/content/108600/${WS_ID}/mods/${MOD}/42/media/lua/server/PanelBridge.lua`;
const ACTIVE_BRIDGE = {
  activatedMods: ["SomeMap", MOD],
  modInfo: { [MOD]: { modVersion: "1.7.71", workshopId: WS_ID } },
};

let root;
let files;
let bridgeDir;

// Start the real bridge in a simulated dedicated server and return the
// status.json text exactly as it would land on disk.
function runBridge({ now = 1759000000000, gameVersion = "42.20.4 b0bbce05d5", engine }) {
  const lua = loadPanelBridge(LUA_PATH, engineStubs({ now, gameVersion }), engine);
  lua.run("PanelBridgeModule.onServerStarted()");
  const written = lua.getGlobal("FILES")["panelbridge/TestServer/status.json.txt"];
  expect(written, "the bridge wrote no status.json").toBeTypeOf("string");
  return written;
}

// The panel side: the real PanelBridge service reading that file from the
// bridge folder (Build 42 bridges write it with a .txt suffix).
function panelReading(statusText) {
  fs.writeFileSync(path.join(bridgeDir, "status.json.txt"), statusText);
  const service = new PanelBridge();
  service.configure(bridgeDir, true);
  service.checkModStatus();
  return service;
}

async function deliveryStatus(server, { statusText, startTime = null }) {
  dbState.servers = [server];
  return getDeliveryStatus(server, {
    serverManager: { startTime },
    rconService: { connected: false },
    modChecker: {},
    bridge: panelReading(statusText),
  });
}

function workshopServer(record = {}) {
  return makeServer(files, {
    bridgeDelivery: "workshop",
    bridgeDeliverySwitch: {
      to: "workshop",
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      by: "admin",
      bridgeStartedAt: 1000,
      workshopId: WS_ID,
      ...record,
    },
  });
}

beforeEach(() => {
  root = createRoot("bridge-heartbeat-");
  files = createServerFiles(root, {
    ini: `Mods=OtherMod;${MOD}\r\nWorkshopItems=111;${WS_ID}\r\nDoLuaChecksum=false\r\n`,
  });
  bridgeDir = path.join(root, "panelbridge", "TestServer");
  fs.mkdirSync(bridgeDir, { recursive: true });
  dbState.servers = [];
  dbState.settings = {};
  runningState.value = true;
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Lua heartbeat -> PanelBridge service -> delivery state", () => {
  it("a bridge loaded from the Workshop item confirms a Workshop server (and the checksum offer opens)", async () => {
    const statusText = runBridge({ engine: { ...ACTIVE_BRIDGE, filenameOfClosure: WORKSHOP_FILE } });

    const status = await deliveryStatus(workshopServer(), { statusText });

    expect(status.state).toBe("workshop-confirmed");
    expect(status.restartedSinceSwitch).toBe(true);
    expect(status.live).toEqual({
      alive: true,
      version: expect.any(String),
      delivery: "workshop",
      workshopId: WS_ID,
      startedAt: 1759000000000,
      gameVersion: "42.20.4 b0bbce05d5",
    });
    expect(status.checksum).toMatchObject({ current: false, canTurnOn: true, turnOnBlockers: [] });
  });

  it("the same run the switch recorded is not a restart: workshop-restart-needed until the bridge starts again", async () => {
    const firstRun = runBridge({ engine: { ...ACTIVE_BRIDGE, filenameOfClosure: WORKSHOP_FILE } });
    const recorded = JSON.parse(firstRun).startedAt;
    const server = workshopServer({ bridgeStartedAt: recorded });

    const before = await deliveryStatus(server, {
      statusText: firstRun,
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    expect(before).toMatchObject({ state: "workshop-restart-needed", restartedSinceSwitch: false });

    const secondRun = runBridge({ now: recorded + 90_000, engine: { ...ACTIVE_BRIDGE, filenameOfClosure: WORKSHOP_FILE } });
    // On the bridge's clock: the panel started this second run a minute
    // before its bridge came up (a heartbeat from before the panel's latest
    // start would be the previous run's).
    const after = await deliveryStatus(server, {
      statusText: secondRun,
      startTime: new Date(recorded + 30_000),
    });
    expect(after).toMatchObject({ state: "workshop-confirmed", restartedSinceSwitch: true });
  });

  it("a panel-installed server whose game loads the Workshop copy is local-workshop-loaded", async () => {
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    const statusText = runBridge({ engine: { ...ACTIVE_BRIDGE, filenameOfClosure: WORKSHOP_FILE } });

    const status = await deliveryStatus(makeServer(files), { statusText });

    expect(status.state).toBe("local-workshop-loaded");
    expect(status.live).toMatchObject({ delivery: "workshop", workshopId: WS_ID });
    // The way out removes the entries: offered, not "already panel-installed".
    expect(status.switchAvailability.toLocal.available).toBe(true);
  });

  it("a Workshop server still running the loose copy is workshop-not-loaded", async () => {
    const statusText = runBridge({
      engine: { filenameOfClosure: "/pz-server/media/lua/server/PanelBridge.lua", activatedMods: ["SomeMap"] },
    });

    const status = await deliveryStatus(workshopServer(), { statusText });

    expect(status.live).toMatchObject({ delivery: "loose", workshopId: null });
    expect(status.state).toBe("workshop-not-loaded");
    expect(status.checksum.canTurnOn).toBe(false);
  });

  it("another Workshop item's PanelBridge.lua is not a confirmation", async () => {
    const statusText = runBridge({
      engine: {
        ...ACTIVE_BRIDGE,
        filenameOfClosure: "/srv/pz/steamapps/workshop/content/108600/999/mods/OtherPack/media/lua/server/PanelBridge.lua",
      },
    });

    const status = await deliveryStatus(workshopServer(), { statusText });

    expect(status.live).toMatchObject({ delivery: "workshop", workshopId: "999" });
    expect(status.state).toBe("workshop-not-loaded");
  });

  it("a Build 41 game version reported by the bridge blocks the Workshop option", async () => {
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    const statusText = runBridge({
      gameVersion: "41.78.16 1a2b3c4d5e",
      engine: { filenameOfClosure: "/pz-server/media/lua/server/PanelBridge.lua", activatedMods: [] },
    });

    const status = await deliveryStatus(makeServer(files), { statusText });

    expect(status.switchAvailability.toWorkshop).toMatchObject({ available: false, reason: "gameVersionUnsupported" });
    expect(status.switchAvailability.toWorkshop.warnings).not.toContain("gameVersionUnknown");
  });
});
