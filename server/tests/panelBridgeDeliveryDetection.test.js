// PanelBridge.detectDelivery tells the panel how the running copy of the
// bridge was delivered, so Settings > PanelBridge can confirm a switch to the
// Steam Workshop item. Primary signal: the path of the file that is actually
// running. 42.20 facts (javap on projectzomboid.jar): getFilenameOfClosure
// returns closure.prototype.filename; FuncState.code stamps every prototype
// with FuncState.currentfullFile; RunLuaInternal sets that to the path it was
// handed with backslashes turned into slashes; LoadDirBase hands it
// ZomboidFileSystem.getAbsolutePath(rel), i.e. the activeFileMap winner, so a
// mod copy that overrides a loose copy reports the mod path. Fallback, when
// that global is missing or throws: the active mod list (getActivatedMods is
// ZomboidFileSystem.getModIDs) plus getModInfoByID(...):getWorkshopID().
import { describe, expect, it } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "pz-mod",
  "PanelBridge",
  "media",
  "lua",
  "server",
  "PanelBridge.lua",
);

const MOD_ID = "ZomboidControlPanelBridge";
const ACTIVE_BRIDGE = {
  activatedMods: ["SomeMap", MOD_ID],
  modInfo: { [MOD_ID]: { modVersion: "1.7.71", workshopId: "3712345678" } },
};

function detect(engine) {
  const bridge = loadPanelBridge(LUA_PATH, "", engine);
  bridge.run("__DELIVERY = PanelBridgeModule.detectDelivery()");
  return { bridge, delivery: bridge.getGlobal("__DELIVERY") };
}

describe("PanelBridge.detectDelivery: the running file's path", () => {
  it.each([
    [
      "a Windows server's Workshop download",
      "C:\\PZServer\\steamapps\\workshop\\content\\108600\\3712345678\\mods\\ZomboidControlPanelBridge\\common\\media\\lua\\server\\PanelBridge.lua",
      { method: "workshop", workshopId: "3712345678" },
    ],
    [
      "a Linux server's Workshop download (42/ version folder)",
      "/home/steam/pzserver/steamapps/workshop/content/108600/3712345678/mods/ZomboidControlPanelBridge/42/media/lua/server/PanelBridge.lua",
      { method: "workshop", workshopId: "3712345678" },
    ],
    [
      "a copy in the Zomboid/mods folder",
      "C:/Users/pz/Zomboid/mods/ZomboidControlPanelBridge/common/media/lua/server/PanelBridge.lua",
      { method: "mod" },
    ],
    [
      "the panel-installed file (Docker all-in-one)",
      "/pz-server/media/lua/server/PanelBridge.lua",
      { method: "loose" },
    ],
    [
      "the panel-installed file (Windows, mixed case)",
      "D:/Games/PZServer/Media/Lua/Server/PanelBridge.lua",
      { method: "loose" },
    ],
  ])("%s", (_label, filename, expected) => {
    const { bridge, delivery } = detect({ ...ACTIVE_BRIDGE, filenameOfClosure: filename });

    expect(delivery).toMatchObject(expected);
    if (expected.method !== "workshop") expect(delivery.workshopId ?? null).toBeNull();
    expect(bridge.getGlobal("GET_FILENAME_OF_CLOSURE_CALLS")).toBe(1);
  });

  it("reports another Workshop item's id when that item's PanelBridge.lua overrides this one", () => {
    // The panel compares the id with its own and shows "didn't load from the Workshop".
    const { delivery } = detect({
      ...ACTIVE_BRIDGE,
      filenameOfClosure: "/srv/pz/steamapps/workshop/content/108600/999/mods/OtherPack/media/lua/server/PanelBridge.lua",
    });

    expect(delivery).toMatchObject({ method: "workshop", workshopId: "999", modActive: true });
  });

  it("reports modActive and the mod.info version when the item is in Mods=", () => {
    const { delivery } = detect({
      ...ACTIVE_BRIDGE,
      filenameOfClosure: "/srv/pz/steamapps/workshop/content/108600/3712345678/mods/ZomboidControlPanelBridge/42/media/lua/server/PanelBridge.lua",
    });

    expect(delivery).toEqual({ method: "workshop", workshopId: "3712345678", modActive: true, modVersion: "1.7.71" });
  });

  it("leaves the mod lookup alone for the default loose install (the mod isn't active)", () => {
    // 42.20 getModDetails reads every installed mod folder's mod.info on a cache miss.
    const { bridge, delivery } = detect({
      filenameOfClosure: "/pz-server/media/lua/server/PanelBridge.lua",
      activatedMods: ["SomeMap"],
      modInfo: { [MOD_ID]: { modVersion: "1.7.71", workshopId: "3712345678" } },
    });

    expect(delivery).toEqual({ method: "loose", modActive: false });
    expect(bridge.getGlobal("GET_MOD_INFO_CALLS")).toBe(0);
  });
});

describe("PanelBridge.detectDelivery: fallback without getFilenameOfClosure", () => {
  it.each([
    ["missing", undefined],
    ["throwing", { throws: "getFilenameOfClosure failed" }],
  ])("getFilenameOfClosure %s, mod active with a Workshop id -> workshop", (_label, filenameOfClosure) => {
    const { delivery } = detect({
      filenameOfClosure,
      activatedMods: [MOD_ID],
      modInfo: { [MOD_ID]: { modVersion: "1.7.71", workshopId: "123" } },
    });

    expect(delivery).toEqual({ method: "workshop", workshopId: "123", modActive: true, modVersion: "1.7.71" });
  });

  it.each([
    ["an empty Workshop id (42.20's value for a Zomboid/mods copy)", ""],
    ["a nil Workshop id", null],
  ])("mod active with %s -> mod", (_label, workshopId) => {
    const { delivery } = detect({
      activatedMods: [MOD_ID],
      modInfo: { [MOD_ID]: { modVersion: "1.7.71", workshopId } },
    });

    expect(delivery).toEqual({ method: "mod", modActive: true, modVersion: "1.7.71" });
  });

  it("mod not active -> loose", () => {
    const { delivery } = detect({
      activatedMods: ["SomeMap"],
      modInfo: { [MOD_ID]: { modVersion: "1.7.71", workshopId: "123" } },
    });

    expect(delivery).toEqual({ method: "loose", modActive: false });
  });

  it("no engine globals at all -> loose", () => {
    const { delivery } = detect({});

    expect(delivery).toEqual({ method: "loose", modActive: false });
  });

  it("a throwing getModInfoByID doesn't crash detection", () => {
    const { bridge, delivery } = detect({
      filenameOfClosure: "/srv/pz/steamapps/workshop/content/108600/3712345678/mods/ZomboidControlPanelBridge/42/media/lua/server/PanelBridge.lua",
      activatedMods: [MOD_ID],
      modInfo: { throws: "getModDetails failed" },
    });

    expect(delivery).toEqual({ method: "workshop", workshopId: "3712345678", modActive: true });
    expect(bridge.getGlobal("GET_MOD_INFO_CALLS")).toBe(1);
  });

  it("a throwing getModInfoByID without a file path falls back to loose", () => {
    const { delivery } = detect({ activatedMods: [MOD_ID], modInfo: { throws: "getModDetails failed" } });

    expect(delivery).toEqual({ method: "loose", modActive: true });
  });

  it("a throwing getActivatedMods doesn't crash detection", () => {
    const { delivery } = detect({
      filenameOfClosure: "/pz-server/media/lua/server/PanelBridge.lua",
      activatedMods: { throws: "getModIDs failed" },
    });

    expect(delivery).toEqual({ method: "loose", modActive: false });
  });
});

// Enough of the engine for PanelBridge.onServerStarted to run end to end;
// writes land in FILES keyed by their Lua-relative path, console lines in PRINTED.
const STARTUP_STUBS = `
FILES = {}
PRINTED = {}
print = function(line) table.insert(PRINTED, tostring(line)) end
NOW = 1759000000000
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
`;

// 42.20 Core.getVersion() is String.valueOf(gameVersion) + ".4 " + the git
// revision, so gameVersion is not a bare "42.20.0": readers parse the leading
// major number.
const CORE_STUB = `
FakeCore = {}
function FakeCore:getVersion() return "42.20.4 b0bbce05d5" end
getCore = function() return FakeCore end
`;

function readWritten(bridge, name) {
  const files = bridge.getGlobal("FILES");
  const text = files[`panelbridge/TestServer/${name}.txt`];
  expect(text, `${name} was not written`).toBeTypeOf("string");
  return JSON.parse(text);
}

describe("PanelBridge heartbeat delivery fields", () => {
  it("status.json carries startedAt, gameVersion and delivery once the server has started", () => {
    const bridge = loadPanelBridge(LUA_PATH, STARTUP_STUBS + CORE_STUB, {
      ...ACTIVE_BRIDGE,
      filenameOfClosure: "/srv/pz/steamapps/workshop/content/108600/3712345678/mods/ZomboidControlPanelBridge/42/media/lua/server/PanelBridge.lua",
    });

    bridge.run("PanelBridgeModule.onServerStarted()");

    const status = readWritten(bridge, "status.json");
    expect(status).toMatchObject({
      alive: true,
      protocolVersion: "queue-v1",
      startedAt: 1759000000000,
      gameVersion: "42.20.4 b0bbce05d5",
      delivery: { method: "workshop", workshopId: "3712345678", modActive: true, modVersion: "1.7.71" },
    });

    const startup = readWritten(bridge, "startup.json");
    expect(startup.delivery).toEqual(status.delivery);
    expect(startup.startTime).toBe(1759000000000);
    expect(bridge.getGlobal("PRINTED")).toContain("[PanelBridge] Loaded from: workshop 3712345678");
  });

  it("startedAt stays at the server start while later heartbeats move on", () => {
    const bridge = loadPanelBridge(LUA_PATH, STARTUP_STUBS + CORE_STUB, {
      filenameOfClosure: "/pz-server/media/lua/server/PanelBridge.lua",
      activatedMods: [],
    });

    bridge.run("PanelBridgeModule.onServerStarted()");
    bridge.run("NOW = NOW + 60000; PanelBridgeModule.updateStatus()");

    const status = readWritten(bridge, "status.json");
    expect(status.timestamp).toBe(1759000060000);
    expect(status.startedAt).toBe(1759000000000);
    expect(status.delivery).toEqual({ method: "loose", modActive: false });
    expect(bridge.getGlobal("PRINTED")).toContain("[PanelBridge] Loaded from: loose");
  });

  it("omits gameVersion when the build couldn't be read", () => {
    const bridge = loadPanelBridge(LUA_PATH, STARTUP_STUBS, {
      filenameOfClosure: "/pz-server/media/lua/server/PanelBridge.lua",
    });

    bridge.run("PanelBridgeModule.onServerStarted()");

    const status = readWritten(bridge, "status.json");
    expect(status).not.toHaveProperty("gameVersion");
    expect(status.delivery).toEqual({ method: "loose", modActive: false });
  });

  it("omits all three fields from a heartbeat written before the server started", () => {
    const bridge = loadPanelBridge(LUA_PATH, STARTUP_STUBS + CORE_STUB, {});

    bridge.run("PanelBridgeModule.updateStatus()");

    const status = readWritten(bridge, "status.json");
    expect(status.alive).toBe(true);
    expect(status).not.toHaveProperty("startedAt");
    expect(status).not.toHaveProperty("gameVersion");
    expect(status).not.toHaveProperty("delivery");
  });
});
