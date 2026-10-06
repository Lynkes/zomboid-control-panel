import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// #197, upgrading. A world that already has a map_sand.bin (live edits made
// through a PanelBridge older than #197, or a save begun as a hosted game)
// loads it over SandboxVars.lua on every start. Those bridges rewrote it
// after every live edit, so the edits lasted; the #197 bridge stopped
// writing it, so live Mod Settings edits, Events > Power and water and the
// scheduler's Save World all reached SandboxVars.lua only and were undone at
// the next start, while the utilities route still answered persisted: true.
// Now the panel looks for the file and tells the bridge
// (worldHasSandboxSnapshot), which rewrites it only then; responses say
// whether the change was kept in it. A world without the file never gets one.

const state = vi.hoisted(() => ({ activeServer: null, settings: {} }));
const remote = vi.hoisted(() => ({ snapshot: null }));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => state.activeServer),
  getAllSettings: vi.fn(async () => state.settings),
  getServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getRoleByName: mockGetRoleByName,
  logBridgeCommand: vi.fn(async () => {}),
  getScheduledTasks: vi.fn(async () => []),
  updateTaskLastRun: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  logScheduleExecution: vi.fn(async () => {}),
}));

// A remote server's world save is checked over SFTP; this stands in for the
// host.
vi.mock("../services/remoteConfigFiles.js", async (importOriginal) => ({
  ...(await importOriginal()),
  findRemoteWorldSandboxSnapshot: vi.fn(async () => remote.snapshot),
}));

const { findRemoteWorldSandboxSnapshot } = await import("../services/remoteConfigFiles.js");
const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");
const { Scheduler } = await import("../services/scheduler.js");
const { logScheduleExecution } = await import("../database/init.js");

const SANDBOX = [
  "SandboxVars = {",
  "    VERSION = 6,",
  "    WaterShut = 2,",
  "    ElecShut = 2,",
  "    WaterShutModifier = 14,",
  "    ElecShutModifier = 14,",
  "    ZombieLore = {",
  "        Cognition = 3,",
  "    },",
  "}",
  "",
].join("\n");

let dataDir;
let configDir;
let snapshotPath;
let sendCommand;
// What the bridge answers each action with; the default is a current
// bridge, which reports the rewrite only when told the world has the file.
let answer;

function currentBridgeAnswer(action, args) {
  const told = args?.worldHasSandboxSnapshot === true;
  const saved = told ? { worldSandboxSaved: true } : {};
  if (action === "setSandboxOption") {
    return { success: true, data: { name: args.name, value: args.value, verified: "confirmed", ...saved } };
  }
  if (action === "restoreUtilities" || action === "shutOffUtilities") {
    return { success: true, data: { message: "ok", power: true, water: true, hydroPowerOn: action === "restoreUtilities", ...saved } };
  }
  if (action === "runEventSequence") {
    return {
      success: true,
      data: {
        executed: args.steps.length,
        failedCount: 0,
        results: args.steps.map((step, i) => ({
          index: i + 1,
          kind: step.kind,
          success: true,
          data: step.kind === "utilities" ? saved : {},
        })),
      },
    };
  }
  if (action === "saveWorld") {
    if (!told) throw new Error("saveWorld is retired");
    return { success: true, data: { message: "map_sand.bin refreshed", worldSandboxSaved: true } };
  }
  return { success: true, data: {} };
}

function giveWorldSnapshot() {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, "SAND");
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const rconService = { connected: true, save: vi.fn() };

async function post(routePath, body = {}, role = "admin") {
  const res = createResponse();
  await getHandler(routePath)(
    { user: { role }, body, app: { get: () => rconService } },
    res,
    () => {},
  );
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
}

function readSandboxVars() {
  return fs.readFileSync(path.join(configDir, "DoB_SandboxVars.lua"), "utf8");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-197-live-"));
  configDir = path.join(dataDir, "Server");
  snapshotPath = path.join(dataDir, "Saves", "Multiplayer", "DoB", "map_sand.bin");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "DoB_SandboxVars.lua"), SANDBOX);
  state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: dataDir, serverConfigPath: configDir, isRemote: false };
  state.settings = {};
  remote.snapshot = null;
  vi.mocked(findRemoteWorldSandboxSnapshot).mockClear();
  vi.mocked(logScheduleExecution).mockClear();
  rconService.save.mockReset().mockResolvedValue({ success: true, response: "World saved" });
  answer = currentBridgeAnswer;
  bridge.isRunning = true;
  bridge.bridgePath = "/fake/bridge";
  sendCommand = vi.spyOn(bridge, "sendCommand").mockImplementation(async (action, args) => answer(action, args));
});

afterEach(() => {
  sendCommand.mockRestore();
  bridge.isRunning = false;
  bridge.bridgePath = null;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Mod Settings live edits (POST /command setSandboxOption, #197)", () => {
  it("tells the bridge the world has a map_sand.bin, and says the edit is kept in it", async () => {
    giveWorldSnapshot();

    const body = await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } });

    expect(sendCommand).toHaveBeenCalledWith("setSandboxOption", {
      name: "ZombieLore.Cognition",
      value: 1,
      worldHasSandboxSnapshot: true,
    });
    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, refreshed: true });
  });

  it("never tells it for a world without one, whatever the caller sends", async () => {
    const body = await post("/command", {
      action: "setSandboxOption",
      args: { name: "ZombieLore.Cognition", value: 1, worldHasSandboxSnapshot: true },
    });

    expect(sendCommand).toHaveBeenCalledWith("setSandboxOption", { name: "ZombieLore.Cognition", value: 1 });
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });

  it("says the next start undoes the edit when the bridge did not rewrite the file", async () => {
    giveWorldSnapshot();
    answer = (action, args) => ({ success: true, data: { name: args.name, value: args.value, verified: "confirmed" } });

    const body = await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } });

    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, refreshed: false });
  });

  // PanelBridge 1.7.72 ignores the flag and runs saveGame() after every
  // live edit, reporting it as `persisted`: the edit is in the file.
  it("reads PanelBridge 1.7.72's persisted as the file rewritten, and its failure as not", async () => {
    giveWorldSnapshot();
    answer = (action, args) => ({ success: true, data: { name: args.name, value: args.value, verified: "confirmed", persisted: true } });
    expect((await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } })).worldSandboxSnapshot)
      .toEqual({ path: snapshotPath, refreshed: true });

    answer = (action, args) => ({ success: true, data: { name: args.name, value: args.value, persisted: false, saveError: "boom" } });
    expect((await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } })).worldSandboxSnapshot)
      .toEqual({ path: snapshotPath, refreshed: false });
  });

  it("leaves an action that changes no sandbox option alone", async () => {
    giveWorldSnapshot();

    const body = await post("/command", { action: "triggerStorm", args: { duration: 1 } });

    expect(sendCommand).toHaveBeenCalledWith("triggerStorm", { duration: 1 });
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
  });

  it("finds a remote world's map_sand.bin over SFTP", async () => {
    state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, isRemote: true };
    state.settings = {
      panelBridgeSftpHost: "sftp.test",
      panelBridgeSftpUsername: "pz",
      panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server",
    };
    remote.snapshot = { path: "/home/pz/Zomboid/Saves/Multiplayer/DoB/map_sand.bin", mtime: "2026-10-05T06:58:03.000Z" };

    const body = await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } });

    expect(findRemoteWorldSandboxSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ host: "sftp.test", configPath: "/home/pz/Zomboid/Server" }),
      "DoB",
    );
    expect(sendCommand).toHaveBeenCalledWith("setSandboxOption", expect.objectContaining({ worldHasSandboxSnapshot: true }));
    expect(body.worldSandboxSnapshot).toEqual({ path: remote.snapshot.path, refreshed: true });
  });

  it("does not tell the bridge when the remote check fails", async () => {
    state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, isRemote: true };
    state.settings = { panelBridgeSftpHost: "sftp.test", panelBridgeSftpUsername: "pz", panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server" };
    vi.mocked(findRemoteWorldSandboxSnapshot).mockRejectedValueOnce(new Error("connection refused"));

    await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } });

    expect(sendCommand).toHaveBeenCalledWith("setSandboxOption", { name: "ZombieLore.Cognition", value: 1 });
  });

  it("gives up on a remote host that doesn't answer, and does not tell the bridge", async () => {
    state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, isRemote: true };
    state.settings = { panelBridgeSftpHost: "sftp.test", panelBridgeSftpUsername: "pz", panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server" };
    vi.mocked(findRemoteWorldSandboxSnapshot).mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } });
      await vi.advanceTimersByTimeAsync(10000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(sendCommand).toHaveBeenCalledWith("setSandboxOption", { name: "ZombieLore.Cognition", value: 1 });
  });

  it("covers an event sequence's utilities steps, and only when it has some", async () => {
    giveWorldSnapshot();
    const steps = [{ kind: "chat", message: "Lights out" }, { kind: "utilities", mode: "off", power: true }];

    const body = await post("/command", { action: "runEventSequence", args: { steps } });
    expect(sendCommand).toHaveBeenLastCalledWith("runEventSequence", { steps, worldHasSandboxSnapshot: true });
    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, refreshed: true });

    const chatOnly = await post("/command", { action: "runEventSequence", args: { steps: [steps[0]] } });
    expect(chatOnly).not.toHaveProperty("worldSandboxSnapshot");
  });
});

describe("Events > Power and water (#197)", () => {
  it("on a world with a map_sand.bin, is persisted only because the bridge kept it there", async () => {
    giveWorldSnapshot();

    const body = await post("/utilities/restore", { power: true, water: true });

    expect(sendCommand).toHaveBeenCalledWith("restoreUtilities", { power: true, water: true, worldHasSandboxSnapshot: true });
    expect(body.persisted).toBe(true);
    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, refreshed: true });
    expect(readSandboxVars()).toContain("ElecShutModifier = 2147483647,");
  });

  // PanelBridge 1.7.72 never saved after restoreUtilities/shutOffUtilities,
  // and answered persisted: true here anyway; the next start undid it.
  it("is not persisted when the bridge didn't keep it in the world's map_sand.bin", async () => {
    giveWorldSnapshot();
    answer = () => ({ success: true, data: { message: "Utilities shut off", power: true, water: true, hydroPowerOn: false } });

    const body = await post("/utilities/shutoff", { power: true, water: true });

    expect(body.persisted).toBe(false);
    expect(body.persistReason).toMatch(/map_sand\.bin/);
    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, refreshed: false });
    // SandboxVars.lua still gets it, for the day the world drops the file.
    expect(readSandboxVars()).toContain("ElecShut = 1,");
  });

  // The next start loads map_sand.bin, which has the change.
  it("counts a change kept in the world's map_sand.bin as persisted when SandboxVars.lua could not take it", async () => {
    giveWorldSnapshot();
    fs.writeFileSync(path.join(configDir, "DoB_SandboxVars.lua"), ["SandboxVars = {", "    VERSION = 6,", "}", ""].join("\n"));

    const body = await post("/utilities/restore", { power: true, water: true });

    expect(body.persisted).toBe(true);
    expect(body.persistReason).toMatch(/kept in the world's map_sand\.bin, but SandboxVars\.lua was not updated/);
    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, refreshed: true });
  });

  it("on a world without one, SandboxVars.lua is what counts and the bridge is not told", async () => {
    const body = await post("/utilities/shutoff", { power: true, water: false });

    expect(sendCommand).toHaveBeenCalledWith("shutOffUtilities", { power: true, water: false });
    expect(body.persisted).toBe(true);
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });

  it("counts SandboxVars.lua already holding the values as persisted", async () => {
    await post("/utilities/shutoff", { power: true, water: true });
    const again = await post("/utilities/shutoff", { power: true, water: true });

    expect(again.persisted).toBe(true);
    expect(again.persistReason ?? null).toBeNull();
  });
});

describe("Save World (#197)", () => {
  function makeScheduler() {
    return new Scheduler(rconService, { _serverId: null });
  }

  it("a stored bridge:saveWorld task saves over RCON, then has the bridge rewrite the world's map_sand.bin", async () => {
    giveWorldSnapshot();

    const result = await makeScheduler().runTaskNow({ id: 1, name: "Save", command: "bridge:saveWorld" });

    expect(result.success).toBe(true);
    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith("saveWorld", { worldHasSandboxSnapshot: true });
  });

  it("a stored bridge:saveWorld task on a world without one only saves", async () => {
    const result = await makeScheduler().runTaskNow({ id: 1, name: "Save", command: "bridge:saveWorld" });

    expect(result.success).toBe(true);
    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  // PanelBridge 1.7.72's saveWorld runs saveGame() regardless and answers
  // { message } only.
  it("accepts PanelBridge 1.7.72's answer to saveWorld", async () => {
    giveWorldSnapshot();
    answer = () => ({ success: true, data: { message: "World save triggered" } });

    expect((await makeScheduler().runTaskNow({ id: 1, name: "Save", command: "bridge:saveWorld" })).success).toBe(true);
  });

  it("fails the task with the reason when the bridge can't rewrite it", async () => {
    giveWorldSnapshot();
    bridge.isRunning = false;

    const result = await makeScheduler().runTaskNow({ id: 1, name: "Save", command: "bridge:saveWorld" });

    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/World saved, but its map_sand\.bin.+not refreshed \(PanelBridge is not running\)/);
  });

  it("a plain save task stays a plain save, as before", async () => {
    giveWorldSnapshot();

    await makeScheduler().runTaskNow({ id: 1, name: "Save", command: "save" });

    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("scheduled power and water changes tell the bridge about the world's map_sand.bin", async () => {
    giveWorldSnapshot();

    await makeScheduler().runTaskNow({ id: 1, name: "Lights out", command: 'bridge:shutOffUtilities {"water":false,"worldHasSandboxSnapshot":false}' });

    expect(sendCommand).toHaveBeenCalledWith("shutOffUtilities", { water: false, worldHasSandboxSnapshot: true });
  });

  it("POST /world/save rewrites the world's map_sand.bin after the RCON save", async () => {
    giveWorldSnapshot();

    const body = await post("/world/save");

    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith("saveWorld", { worldHasSandboxSnapshot: true });
    expect(body).toMatchObject({ success: true, worldSandboxSnapshot: { path: snapshotPath, refreshed: true } });
  });
});

// The live-change check runs outside Server Files, so it applies Server
// Files' own folder rules itself (utils/serverConfigPath.js): a server whose
// folders Server Config refuses gets no world save check at all. Nothing
// under its data folder is looked at, and the bridge is told nothing.
describe("a server whose folders Server Config refuses (FILES-2, PATHS-1)", () => {
  let otherDir;
  let statSpy;

  beforeEach(() => {
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-197-live-other-"));
    statSpy = vi.spyOn(fs.promises, "stat");
  });

  afterEach(() => {
    statSpy.mockRestore();
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  const statsUnder = (folder) =>
    statSpy.mock.calls.filter((call) => path.resolve(String(call[0])).startsWith(path.resolve(folder) + path.sep));

  it("a config folder outside its data folder", async () => {
    giveWorldSnapshot();
    state.activeServer = { ...state.activeServer, serverConfigPath: path.join(otherDir, "Server") };

    const body = await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } });

    expect(sendCommand).toHaveBeenCalledWith("setSandboxOption", { name: "ZombieLore.Cognition", value: 1 });
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
    expect(statsUnder(path.join(dataDir, "Saves"))).toEqual([]);
  });

  it("a config folder with no data folder to anchor it", async () => {
    giveWorldSnapshot();
    state.activeServer = { ...state.activeServer, zomboidDataPath: null };

    const body = await post("/utilities/shutoff", { power: true, water: true });

    expect(sendCommand).toHaveBeenCalledWith("shutOffUtilities", { power: true, water: true });
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
    expect(statsUnder(path.join(dataDir, "Saves"))).toEqual([]);
    expect(body.persisted).toBe(false);
    expect(readSandboxVars()).toBe(SANDBOX);
  });

  // SECURITY: Events > Power and water writes SandboxVars.lua through
  // persistSandboxValues(), outside Server Files' router, so its gate never
  // judged the folder: one Server Config refuses was written to anyway, with
  // a backups folder made beside it. server.world_events is enough for these
  // routes, and the seeded moderator has it.
  it.each([
    [
      "/utilities/restore",
      "a config folder outside its data folder",
      /must be the Server folder inside this server's Zomboid data folder/,
      () => {
        const elsewhere = path.join(otherDir, "Server");
        fs.mkdirSync(elsewhere);
        fs.writeFileSync(path.join(elsewhere, "DoB_SandboxVars.lua"), SANDBOX);
        state.activeServer = { ...state.activeServer, serverConfigPath: elsewhere };
        return elsewhere;
      },
    ],
    [
      "/utilities/shutoff",
      "a config folder with no data folder to anchor it",
      /must be the Server folder inside this server's Zomboid data folder/,
      () => {
        state.activeServer = { ...state.activeServer, zomboidDataPath: null };
        return configDir;
      },
    ],
    [
      "/utilities/shutoff",
      "a data folder the data-folder rule refuses",
      /holds files the game doesn't keep in a data folder/,
      () => {
        fs.writeFileSync(path.join(dataDir, "notes.txt"), "not the game's");
        return configDir;
      },
    ],
  ])("%s writes nothing to %s, and says why", async (route, _label, reason, setUp) => {
    const folder = setUp();

    const body = await post(route, { power: true, water: true }, "moderator");

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ persisted: false, persistReason: expect.stringMatching(reason) });
    expect(fs.readFileSync(path.join(folder, "DoB_SandboxVars.lua"), "utf8")).toBe(SANDBOX);
    expect(fs.existsSync(path.join(folder, "backups"))).toBe(false);
  });

  it("a data folder the data-folder rule refuses", async () => {
    fs.writeFileSync(path.join(dataDir, "notes.txt"), "not the game's");
    fs.mkdirSync(path.join(dataDir, "Saves", "Multiplayer", "DoB"), { recursive: true });

    const result = await new Scheduler(rconService, { _serverId: null }).runTaskNow({
      id: 1,
      name: "Save",
      command: "bridge:saveWorld",
    });

    expect(result.success).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(statsUnder(path.join(dataDir, "Saves"))).toEqual([]);
  });
});

// The world save's path is a host path: a role without the host-path
// capabilities (utils/hostPathView.js; the seeded moderator has none) gets
// its file name only.
describe("map_sand.bin for a role that can't see host folders (#197)", () => {
  it("POST /command, /utilities/restore and /world/save name the file only", async () => {
    giveWorldSnapshot();

    const answers = [
      await post("/command", { action: "setSandboxOption", args: { name: "ZombieLore.Cognition", value: 1 } }, "moderator"),
      await post("/utilities/restore", { power: true, water: true }, "moderator"),
      await post("/world/save", {}, "moderator"),
    ];

    for (const body of answers) {
      expect(body.worldSandboxSnapshot).toEqual({ path: "map_sand.bin", refreshed: true });
      expect(JSON.stringify(body)).not.toContain(JSON.stringify(dataDir).slice(1, -1));
    }
  });
});
