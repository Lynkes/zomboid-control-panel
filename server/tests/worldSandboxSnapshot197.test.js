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
// save, only while the server is stopped.

const state = vi.hoisted(() => ({ activeServer: null, running: false, mirrorDir: null }));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => state.activeServer),
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

// A remote server with SFTP set up: its Server/ folder is mirrored into
// state.mirrorDir, and nothing else of the remote host is reachable.
vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(async () => () => {}),
  beginRemoteConfigSession: vi.fn(async () => ({})),
  getMirrorPath: vi.fn(() => state.mirrorDir),
  isRemoteConfigConfigured: vi.fn(() => Boolean(state.activeServer?.isRemote)),
  pushRemoteConfigFiles: vi.fn(async () => {}),
  validateRemoteConfigTransport: vi.fn(async () => ({ host: "sftp.test" })),
}));

const { default: router } = await import("../routes/serverFiles.js");

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
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: "u1", username: "op", role: "admin" };
    next();
  });
  app.set("serverManager", {
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: state.running, scanFailed: false }),
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
  state.running = false;
  state.mirrorDir = null;
});

afterEach(() => {
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

  it("says nothing for a remote server, whose save the panel can't see", async () => {
    state.activeServer = { ...state.activeServer, isRemote: true };
    state.mirrorDir = configDir;

    const { status, body } = await call("GET", "/sandbox");

    expect(status).toBe(200);
    expect(body.sandbox.ZombieLore).toEqual({ Cognition: 3, DoorOpeningPercentage: 0 });
    expect(body).not.toHaveProperty("worldSandboxSnapshot");
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

  it("refuses for a remote server", async () => {
    state.activeServer = { ...state.activeServer, isRemote: true };
    state.mirrorDir = configDir;

    const { status, body } = await call("POST", "/sandbox/world-snapshot/retire");

    expect(status).toBe(400);
    expect(body.code).toBe("WORLD_SANDBOX_SNAPSHOT_UNAVAILABLE");
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
});
