import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// #197: the world save's map_sand.bin holds its own copy of every sandbox
// option, and Build 42 applies it over SandboxVars.lua on every start
// (SandboxOptions.load(), after GameServer.doMinimumInit has read the .lua).
// PanelBridge's live edits created it, after which every SandboxVars.lua
// change, from this panel or the in-game admin panel, was undone at the next
// restart. Server Config now reports the file and can move it out of the
// save, only while the server is stopped. A remote server's file is reached
// over SFTP (remoteConfigFiles.js; its own test drives a real sftp-server).

const state = vi.hoisted(() => ({
  activeServer: null,
  settings: {},
  running: false,
  rconConnected: false,
  mirrorDir: null,
  session: {},
  remoteRetire: null,
  role: "admin",
}));

// A custom role that edits Server Config without the host-path
// capabilities (utils/hostPathView.js): it sees a host path's file name only.
const FILES_ONLY_ROLE = vi.hoisted(() => ({
  id: "role-files-only",
  name: "files-only",
  capabilities: ["serverfiles.manage"],
}));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => state.activeServer),
  getAllSettings: vi.fn(async () => state.settings),
  getRoleByName: async (name) => (name === FILES_ONLY_ROLE.name ? FILES_ONLY_ROLE : mockGetRoleByName(name)),
}));

// A remote server with SFTP set up: its Server/ folder is mirrored into
// state.mirrorDir, and the mirror session says what the host's world save
// holds (state.session.worldSandboxSnapshot).
const TRANSPORT = vi.hoisted(() => ({ host: "sftp.test", configPath: "/home/pz/Zomboid/Server" }));
vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(async () => () => {}),
  beginRemoteConfigSession: vi.fn(async () => state.session),
  getMirrorPath: vi.fn(() => state.mirrorDir),
  isRemoteConfigConfigured: vi.fn(() => Boolean(state.activeServer?.isRemote)),
  pushRemoteConfigFiles: vi.fn(async () => {}),
  retireRemoteWorldSandboxSnapshot: vi.fn(async () => state.remoteRetire),
  validateRemoteConfigTransport: vi.fn(() => TRANSPORT),
}));

const { retireRemoteWorldSandboxSnapshot } = await import("../services/remoteConfigFiles.js");
const { default: router, __testOnlyDirectReads } = await import("../routes/serverFiles.js");
const { localWorldSandboxSnapshotPath } = await import("../services/worldSandboxSnapshot.js");

const SANDBOX = "SandboxVars = {\n    VERSION = 6,\n    ZombieLore = {\n        Cognition = 3,\n        DoorOpeningPercentage = 0,\n    },\n}\n";
// The bytes do not matter to the panel; keep them recognisable.
const SNAPSHOT = Buffer.from("SAND fake snapshot: Cognition=1 DoorOpeningPercentage=5");

let server;
let baseUrl;
let dataDir;
let configDir;
let saveDir;
let snapshotPath;

async function call(method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Express's own error page.
  }
  return { status: response.status, body: parsed };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: "u1", username: "op", role: state.role };
    next();
  });
  app.set("serverManager", {
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: state.running, scanFailed: false }),
  });
  app.set("rconService", {
    get connected() {
      return state.rconConnected;
    },
  });
  app.use("/", router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-map-sand-197-"));
  configDir = path.join(dataDir, "Server");
  saveDir = path.join(dataDir, "Saves", "Multiplayer", "DoB");
  snapshotPath = path.join(saveDir, "map_sand.bin");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "DoB_SandboxVars.lua"), SANDBOX);
  fs.writeFileSync(snapshotPath, SNAPSHOT);
  state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: dataDir, isRemote: false };
  state.settings = {};
  state.running = false;
  state.rconConnected = false;
  state.mirrorDir = null;
  state.session = {};
  state.remoteRetire = null;
  state.role = "admin";
  vi.mocked(retireRemoteWorldSandboxSnapshot).mockClear();
});

const REMOTE_SNAPSHOT = {
  path: "/home/pz/Zomboid/Saves/Multiplayer/DoB/map_sand.bin",
  mtime: "2026-10-05T06:58:03.000Z",
};

// A remote server whose Server/ folder is mirrored into configDir. The world
// save in this test's local data folder is not the one it reads.
function makeRemote({ snapshot }) {
  state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, isRemote: true };
  state.mirrorDir = configDir;
  state.session = { worldSandboxSnapshot: snapshot ? REMOTE_SNAPSHOT : null };
}

let homedirSpy = null;

// The game's default data folder (Zomboid in the home folder), pointed at
// this test's data folder.
function homeHoldsDataDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-map-sand-197-home-"));
  fs.cpSync(dataDir, path.join(home, "Zomboid"), { recursive: true });
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
  return path.join(home, "Zomboid");
}

// A server whose config folder is anchored by the legacy setting's data
// folder (FILES-2's data folder in effect) while its record has none: the
// panel's start script passes no -cachedir then, so the game keeps its save
// in its default folder.
function legacyAnchoredProfile(extra = {}) {
  state.settings = { zomboidDataPath: dataDir };
  state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, serverConfigPath: configDir, isRemote: false, ...extra };
}

// Every fs.promises.stat() call, to show a folder was never looked in.
let statSpy = null;
function statCalls() {
  statSpy = vi.spyOn(fs.promises, "stat");
  return statSpy;
}

const under = (folder) => (call) => path.resolve(String(call[0])).startsWith(path.resolve(folder) + path.sep);

afterEach(() => {
  if (statSpy) {
    statSpy.mockRestore();
    statSpy = null;
  }
  if (homedirSpy) {
    const home = os.homedir();
    homedirSpy.mockRestore();
    homedirSpy = null;
    fs.rmSync(home, { recursive: true, force: true });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Server Config reports the world's own sandbox copy (#197)", () => {
  it("GET /sandbox names map_sand.bin and when it was last written", async () => {
    const mtime = new Date("2026-10-05T06:58:03.000Z");
    fs.utimesSync(snapshotPath, mtime, mtime);

    const { status, body } = await call("GET", "/sandbox");

    expect(status).toBe(200);
    expect(body.worldSandboxSnapshot).toEqual({ path: snapshotPath, mtime: mtime.toISOString() });
    expect(body.sandbox.ZombieLore).toEqual({ Cognition: 3, DoorOpeningPercentage: 0 });
  });

  it("GET /raw/sandbox reports it too, GET /raw/ini does not", async () => {
    fs.writeFileSync(path.join(configDir, "DoB.ini"), "PVP=true\n");

    expect((await call("GET", "/raw/sandbox")).body.worldSandboxSnapshot?.path).toBe(snapshotPath);
    expect((await call("GET", "/raw/ini")).body).not.toHaveProperty("worldSandboxSnapshot");
  });

  it("PUT /sandbox saves, and says the world will not use the save", async () => {
    const { status, body } = await call("PUT", "/sandbox", {
      sandbox: { ZombieLore: { Cognition: 2 } },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.worldSandboxSnapshot?.path).toBe(snapshotPath);
    expect(fs.readFileSync(path.join(configDir, "DoB_SandboxVars.lua"), "utf8")).toContain("Cognition = 2,");
  });

  it("says nothing for a world without map_sand.bin (what a vanilla dedicated server has)", async () => {
    fs.rmSync(snapshotPath);

    expect((await call("GET", "/sandbox")).body).not.toHaveProperty("worldSandboxSnapshot");
    expect((await call("GET", "/raw/sandbox")).body).not.toHaveProperty("worldSandboxSnapshot");
  });

  it("PUT /sandbox-option says so too: Mod Settings writes there after a live edit", async () => {
    const { status, body } = await call("PUT", "/sandbox-option", { name: "ZombieLore.Cognition", value: 2 });

    expect(status).toBe(200);
    expect(body.persisted).toBe(true);
    expect(body.worldSandboxSnapshot?.path).toBe(snapshotPath);

    fs.rmSync(snapshotPath);
    const again = await call("PUT", "/sandbox-option", { name: "ZombieLore.Cognition", value: 1 });
    expect(again.body).not.toHaveProperty("worldSandboxSnapshot");
  });

  it("reports a remote world's map_sand.bin, found over SFTP", async () => {
    makeRemote({ snapshot: true });

    const { status, body } = await call("GET", "/sandbox");

    expect(status).toBe(200);
    expect(body.sandbox.ZombieLore).toEqual({ Cognition: 3, DoorOpeningPercentage: 0 });
    expect(body.worldSandboxSnapshot).toEqual(REMOTE_SNAPSHOT);
    expect((await call("GET", "/raw/sandbox")).body.worldSandboxSnapshot).toEqual(REMOTE_SNAPSHOT);
    const saved = await call("PUT", "/sandbox", { sandbox: { ZombieLore: { Cognition: 2 } } });
    expect(saved.body.worldSandboxSnapshot).toEqual(REMOTE_SNAPSHOT);
    const option = await call("PUT", "/sandbox-option", { name: "ZombieLore.Cognition", value: 1 });
    expect(option.body.worldSandboxSnapshot).toEqual(REMOTE_SNAPSHOT);
  });

  it("says nothing for a remote world without one", async () => {
    makeRemote({ snapshot: false });

    expect((await call("GET", "/sandbox")).body).not.toHaveProperty("worldSandboxSnapshot");
  });

  // FILES-2/PATHS-2: a config folder with no data folder to anchor it is
  // refused before any route runs, so the save next to it isn't looked at.
  it("says nothing about the world save of a profile whose config folder has no data folder, which Server Config refuses", async () => {
    state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, serverConfigPath: configDir, isRemote: false };
    const stat = statCalls();

    const { status, body } = await call("GET", "/sandbox");

    expect(status).toBe(400);
    expect(body.code).toBe("SERVER_CONFIG_PATH_OUTSIDE_DATA");
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
    expect(stat.mock.calls.filter(under(path.join(dataDir, "Saves")))).toEqual([]);
  });

  // The panel's start script passes -cachedir only for the record's own data
  // folder, so without one the game keeps its save in its default folder.
  it("finds the save in the game's default folder for a profile with no data folder of its own that the panel starts", async () => {
    const install = path.join(dataDir, "install");
    fs.mkdirSync(install);
    const home = homeHoldsDataDir();
    legacyAnchoredProfile({ installPath: install });

    const expected = path.join(home, "Saves", "Multiplayer", "DoB", "map_sand.bin");
    expect((await call("GET", "/sandbox")).body.worldSandboxSnapshot?.path).toBe(expected);
  });

  // PATHS-1: the default folder is no folder the gate judged, so it is held
  // to the data-folder rule before anything under it is looked at.
  it("never looks in a default folder the data-folder rule refuses", async () => {
    const install = path.join(dataDir, "install");
    fs.mkdirSync(install);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-map-sand-197-home-"));
    fs.mkdirSync(path.join(home, "Zomboid", "Saves"), { recursive: true });
    fs.writeFileSync(path.join(home, "Zomboid", "notes.txt"), "not the game's");
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    legacyAnchoredProfile({ installPath: install });
    const stat = statCalls();

    expect((await call("GET", "/sandbox")).body).not.toHaveProperty("worldSandboxSnapshot");
    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(400);
    expect(body.code).toBe("ZOMBOID_DATA_FOLDER_REFUSED");
    expect(stat.mock.calls.filter(under(path.join(home, "Zomboid", "Saves")))).toEqual([]);
    expect(fs.existsSync(path.join(configDir, "backups"))).toBe(false);
  });

  it("finds a legacy setup's save (no profile row) under the data folder in its settings", async () => {
    state.activeServer = null;
    state.settings = { serverName: "DoB", zomboidDataPath: dataDir };

    const { status, body } = await call("GET", "/sandbox");

    expect(status).toBe(200);
    expect(body.worldSandboxSnapshot?.path).toBe(snapshotPath);
  });
});

describe("a server name of '.' or '..' (#197)", () => {
  // Both pass a basename test, and the world save's path uses the name as a
  // folder: Saves/Multiplayer/.. is Saves/.
  it("is refused before any path is built from it", async () => {
    const above = path.join(dataDir, "Saves", "map_sand.bin");
    fs.writeFileSync(above, "not this world's");
    for (const serverName of [".", ".."]) {
      state.activeServer = { id: 1, serverName, zomboidDataPath: dataDir, isRemote: false };

      await expect(__testOnlyDirectReads.getActiveServerPaths()).rejects.toThrow(/invalid path characters/);
      await expect(__testOnlyDirectReads.getServerName()).rejects.toThrow(/invalid path characters/);
      expect(localWorldSandboxSnapshotPath({ activeServer: state.activeServer, serverName, serverConfigPath: configDir })).toBeNull();
      expect((await call("POST", "/sandbox/world-snapshot/retire")).status).toBe(500);
    }
    expect(fs.readFileSync(above, "utf8")).toBe("not this world's");
    expect(fs.existsSync(path.join(configDir, "backups"))).toBe(false);
  });
});

describe("POST /sandbox/world-snapshot/retire (#197)", () => {
  it("moves map_sand.bin into the config backups folder, intact, so the next start uses SandboxVars.lua", async () => {
    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, retired: true });
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(path.dirname(body.movedTo)).toBe(path.join(configDir, "backups"));
    expect(path.basename(body.movedTo)).toMatch(/^DoB_map_sand\.bin\..+\.retired$/);
    expect(fs.readFileSync(body.movedTo)).toEqual(SNAPSHOT);
    expect((await call("GET", "/sandbox")).body).not.toHaveProperty("worldSandboxSnapshot");
  });

  it("keeps it out of the config backup list, which would restore it into Server/", async () => {
    await call("POST", "/sandbox/world-snapshot/retire");

    const { body } = await call("GET", "/backups");
    expect(body.backups.map((b) => b.filename)).toEqual([]);
  });

  it("keeps both copies when retired twice in a row", async () => {
    const first = (await call("POST", "/sandbox/world-snapshot/retire")).body.movedTo;
    fs.writeFileSync(snapshotPath, "second");
    const second = (await call("POST", "/sandbox/world-snapshot/retire")).body.movedTo;

    expect(second).not.toBe(first);
    expect(fs.readFileSync(first)).toEqual(SNAPSHOT);
    expect(fs.readFileSync(second, "utf8")).toBe("second");
  });

  it("refuses while the server is running and leaves the file in place", async () => {
    state.running = true;

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(409);
    expect(body.code).toBe("SERVER_RUNNING");
    expect(fs.readFileSync(snapshotPath)).toEqual(SNAPSHOT);
  });

  it("refuses every spelling Express routes to it while the server is running", async () => {
    state.running = true;

    for (const spelling of ["/SANDBOX/World-Snapshot/RETIRE", "/sandbox/world-snapshot/retire/"]) {
      expect((await call("POST", spelling)).status, spelling).toBe(409);
    }
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });

  it("is a no-op for a world without map_sand.bin", async () => {
    fs.rmSync(snapshotPath);

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, retired: false });
    expect(fs.existsSync(path.join(configDir, "backups"))).toBe(false);
  });

  it("moves a remote world's map_sand.bin over SFTP, into the backups folder on the host", async () => {
    makeRemote({ snapshot: true });
    const movedTo = "/home/pz/Zomboid/Server/backups/DoB_map_sand.bin.2026-10-05T07-00-00-000Z.retired";
    state.remoteRetire = { available: true, retired: true, movedTo };

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, retired: true, movedTo });
    expect(retireRemoteWorldSandboxSnapshot).toHaveBeenCalledWith(TRANSPORT, "DoB");
    // The local data folder was never the remote server's.
    expect(fs.readFileSync(snapshotPath)).toEqual(SNAPSHOT);
  });

  it("is a no-op for a remote world without map_sand.bin", async () => {
    makeRemote({ snapshot: false });
    state.remoteRetire = { available: true, retired: false };

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, retired: false });
  });

  it("refuses for a remote server while its RCON is connected, and moves nothing", async () => {
    makeRemote({ snapshot: true });
    state.rconConnected = true;

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(409);
    expect(body.code).toBe("SERVER_RUNNING");
    expect(retireRemoteWorldSandboxSnapshot).not.toHaveBeenCalled();
  });

  it("refuses for a remote server whose config folder isn't its Server folder", async () => {
    makeRemote({ snapshot: false });
    state.remoteRetire = { available: false, retired: false };

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(400);
    expect(body.code).toBe("WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE");
  });

  // FILES-2/PATHS-2: refused before the handler runs; nothing moves.
  it("moves nothing for a profile whose config folder has no data folder, which Server Config refuses", async () => {
    state.activeServer = { id: 1, serverName: "DoB", zomboidDataPath: null, serverConfigPath: configDir, isRemote: false };

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(400);
    expect(body.code).toBe("SERVER_CONFIG_PATH_OUTSIDE_DATA");
    expect(fs.readFileSync(snapshotPath)).toEqual(SNAPSHOT);
    expect(fs.existsSync(path.join(configDir, "backups"))).toBe(false);
  });

  it("retires from the game's default folder for a profile with no data folder of its own that the panel starts", async () => {
    const install = path.join(dataDir, "install");
    fs.mkdirSync(install);
    const home = homeHoldsDataDir();
    legacyAnchoredProfile({ installPath: install });

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body.retired).toBe(true);
    expect(fs.existsSync(path.join(home, "Saves", "Multiplayer", "DoB", "map_sand.bin"))).toBe(false);
    expect(path.dirname(body.movedTo)).toBe(path.join(configDir, "backups"));
    expect(fs.readFileSync(body.movedTo)).toEqual(SNAPSHOT);
  });

  it("retires a legacy setup's file (no profile row)", async () => {
    state.activeServer = null;
    state.settings = { serverName: "DoB", zomboidDataPath: dataDir };

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body.retired).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(fs.readFileSync(body.movedTo)).toEqual(SNAPSHOT);
  });

  // The local stopped check can't see a remote host's processes; for a
  // profile whose local paths are set (and only exist on the host) it
  // answered SERVER_STATE_UNKNOWN. The server's own RCON decides instead.
  it("moves a remote world's file when the profile's local paths exist only on the host", async () => {
    makeRemote({ snapshot: true });
    state.activeServer.installPath = "/home/pz/pzserver-not-on-this-computer";
    const movedTo = "/home/pz/Zomboid/Server/backups/DoB_map_sand.bin.2026-10-05T07-00-00-000Z.retired";
    state.remoteRetire = { available: true, retired: true, movedTo };

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, retired: true, movedTo });

    state.rconConnected = true;
    const refused = await call("POST", "/sandbox/world-snapshot/retire");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SERVER_RUNNING");
  });

  // A start the panel doesn't write (a custom command) may pass its own
  // -cachedir, and a config folder not named Server doesn't say where.
  it("says no data folder is set when the save's place can't be told", async () => {
    const cfg = path.join(configDir, "cfg");
    fs.mkdirSync(cfg);
    fs.copyFileSync(path.join(configDir, "DoB_SandboxVars.lua"), path.join(cfg, "DoB_SandboxVars.lua"));
    state.settings = { zomboidDataPath: dataDir };
    state.activeServer = {
      id: 1,
      serverName: "DoB",
      startCommand: "./my-start.sh",
      zomboidDataPath: null,
      serverConfigPath: cfg,
      isRemote: false,
    };

    expect((await call("GET", "/sandbox")).body).not.toHaveProperty("worldSandboxSnapshot");
    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(400);
    expect(body.code).toBe("WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE");
    expect(body.error).toMatch(/can't tell where this server's world save is.+Set the server's data folder/);
    expect(body.error).not.toMatch(/not on this computer/);
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
});

// The world save's path is a host path: a role without the host-path
// capabilities (utils/hostPathView.js) gets its file name only, as it does
// for every other path Server Config answers with.
describe("map_sand.bin for a role that can't see host folders (#197)", () => {
  beforeEach(() => {
    state.role = FILES_ONLY_ROLE.name;
  });

  it("GET and PUT /sandbox, PUT /sandbox-option and GET /raw/sandbox name the file only", async () => {
    const answers = [
      (await call("GET", "/sandbox")).body,
      (await call("PUT", "/sandbox", { sandbox: { ZombieLore: { Cognition: 2 } } })).body,
      (await call("PUT", "/sandbox-option", { name: "ZombieLore.Cognition", value: 1 })).body,
      (await call("GET", "/raw/sandbox")).body,
    ];

    for (const body of answers) {
      expect(body.worldSandboxSnapshot.path).toBe("map_sand.bin");
      expect(body.worldSandboxSnapshot.mtime).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain(JSON.stringify(dataDir).slice(1, -1));
    }
  });

  it("the retire route names the moved file only, for a local and a remote world", async () => {
    const local = (await call("POST", "/sandbox/world-snapshot/retire")).body;
    expect(local.retired).toBe(true);
    expect(local.movedTo).toMatch(/^DoB_map_sand\.bin\..+\.retired$/);
    expect(fs.readdirSync(path.join(configDir, "backups"))).toEqual([local.movedTo]);

    makeRemote({ snapshot: true });
    state.remoteRetire = {
      available: true,
      retired: true,
      movedTo: "/home/pz/Zomboid/Server/backups/DoB_map_sand.bin.2026-10-05T07-00-00-000Z.retired",
    };
    const remote = (await call("POST", "/sandbox/world-snapshot/retire")).body;
    expect(remote).toMatchObject({ retired: true, movedTo: "DoB_map_sand.bin.2026-10-05T07-00-00-000Z.retired" });

    expect((await call("GET", "/sandbox")).body.worldSandboxSnapshot).toEqual({
      path: "map_sand.bin",
      mtime: REMOTE_SNAPSHOT.mtime,
    });
  });
});
