import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /backup/restore/:name, backupService.restoreBackup() and POST
// /server/wipe all asked "is the server stopped?" with the LOCAL process scan
// alone (serverManager.getServerProcessDetails()). With the game in another
// container (a docker-local setup, GH#114) that scan succeeds and finds
// nothing while the server is up and has the world open, so a restore or a
// wipe went ahead underneath it. They now gate on the verdict the status
// badge, the watchdog and Discord use, resolveObservedServerRunning():
// running refuses, "cannot tell" refuses as "can't verify".

const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getRoleByName: mockGetRoleByName,
  logServerEvent: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: backupRouter } = await import("../routes/backup.js");
const { default: serverRouter } = await import("../routes/server.js");
const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";

// A docker-local profile with Docker control off: the panel cannot see the
// container, so the container signal is "unknown", exactly the topology the
// local scan is blind to.
const DOCKER_LOCAL_SERVER = {
  id: "s1",
  serverName: SERVER_NAME,
  provider: "docker-local",
  dockerContainerName: "pz",
};

const CLEAN_SCAN = async () => ({ running: false, scanFailed: false });

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status: (code) => {
      statusCode = code;
      return response;
    },
    json: (payload) => {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

async function runRestoreRoute({ serverManager, rconService }) {
  const restoreBackup = vi.fn(async () => ({ success: true }));
  const services = {
    backupService: { restoreBackup },
    serverManager,
    rconService,
    io: { emit: vi.fn() },
  };
  const layer = backupRouter.stack.find(
    (entry) => entry.route?.path === "/restore/:name" && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = {
    user: { role: "admin" },
    params: { name: "good.zip" },
    body: {},
    app: { get: (key) => services[key] },
  };
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return { res, restoreBackup };
}

describe("POST /backup/restore/:name gates on the observed running state", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
  });

  it("refuses a docker-local server whose RCON is connected although the local scan finds nothing", async () => {
    getActiveServer.mockResolvedValue(DOCKER_LOCAL_SERVER);

    const { res, restoreBackup } = await runRestoreRoute({
      serverManager: { getServerProcessDetails: CLEAN_SCAN },
      rconService: { connected: true },
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "BACKUP_RESTORE_SERVER_RUNNING" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("refuses with SERVER_STATE_UNKNOWN when nothing can tell whether a docker-local server is up", async () => {
    getActiveServer.mockResolvedValue(DOCKER_LOCAL_SERVER);

    const { res, restoreBackup } = await runRestoreRoute({
      serverManager: { getServerProcessDetails: CLEAN_SCAN },
      rconService: { connected: false },
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("lets RCON vouch for a systemd server whose answer came from the plain scan", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", serverName: SERVER_NAME, lifecycleProvider: "systemd" });

    const { res, restoreBackup } = await runRestoreRoute({
      serverManager: { getServerProcessDetails: CLEAN_SCAN },
      rconService: { connected: true },
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "BACKUP_RESTORE_SERVER_RUNNING" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("treats a scan that throws as 'cannot verify', not as a server error or a stopped server", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", serverName: SERVER_NAME });

    const { res, restoreBackup } = await runRestoreRoute({
      serverManager: {
        getServerProcessDetails: async () => {
          throw new Error("ps failed");
        },
      },
      rconService: { connected: false },
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("still restores a native server that every signal agrees is stopped", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", serverName: SERVER_NAME });

    const { res, restoreBackup } = await runRestoreRoute({
      serverManager: { getServerProcessDetails: CLEAN_SCAN },
      rconService: { connected: false },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(restoreBackup).toHaveBeenCalledWith("good.zip", expect.anything());
  });
});

describe("backupService.restoreBackup() applies the same gate itself", () => {
  let root;
  let savesPath;
  let backupsPath;

  beforeEach(() => {
    getActiveServer.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-restore-observed-"));
    savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
    backupsPath = path.join(root, "backups");
    fs.mkdirSync(savesPath, { recursive: true });
    fs.mkdirSync(backupsPath, { recursive: true });
    fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
    fs.writeFileSync(path.join(backupsPath, "good.zip"), "PK\u0003\u0004 not read");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createService(rconService) {
    const service = new BackupService();
    service.getSavesPath = async () => savesPath;
    service.getBackupsPath = async () => backupsPath;
    service.setServerManager({ getServerProcessDetails: CLEAN_SCAN });
    service.setRconService(rconService);
    return service;
  }

  it("refuses a docker-local server whose RCON is connected although the local scan finds nothing", async () => {
    getActiveServer.mockResolvedValue(DOCKER_LOCAL_SERVER);

    const result = await createService({ connected: true }).restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still running/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
  });

  it("refuses when nothing can tell whether a docker-local server is up", async () => {
    getActiveServer.mockResolvedValue(DOCKER_LOCAL_SERVER);

    const result = await createService({ connected: false }).restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/could not confirm the server is stopped/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
  });

  it("keeps the explicit force override that already existed", async () => {
    getActiveServer.mockResolvedValue(DOCKER_LOCAL_SERVER);

    const result = await createService({ connected: true }).restoreBackup("good.zip", {
      createPreRestoreBackup: false,
      force: true,
    });

    // Past the running gate: it fails later, on the placeholder archive.
    expect(result.message).not.toMatch(/still running|could not confirm/i);
  });
});

describe("POST /server/wipe gates on the observed running state", () => {
  let root;
  let saveDir;

  function getWipeHandler() {
    const layer = serverRouter.stack.find(
      (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
    );
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  }

  async function runWipe({ server, rconService }) {
    getActiveServer.mockResolvedValue({
      zomboidDataPath: root,
      serverName: SERVER_NAME,
      ...server,
    });
    const serverManager = {
      loadConfig: async () => {},
      reloadConfig: async () => {},
      getServerProcessDetails: CLEAN_SCAN,
    };
    const backupService = {
      createBackup: vi.fn(async () => ({ success: true, backup: { name: "x.zip" }, skippedFiles: [] })),
    };
    const services = { serverManager, backupService, rconService };
    const res = createResponse();
    await getWipeHandler()(
      {
        app: { get: (key) => services[key] },
        body: { targets: ["map"], confirm: true, createBackup: false },
      },
      res,
    );
    return res;
  }

  beforeEach(() => {
    getActiveServer.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-observed-"));
    saveDir = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
    fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
    fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a docker-local server whose RCON is connected although the local scan finds nothing", async () => {
    const res = await runWipe({
      server: { id: "s1", provider: "docker-local", dockerContainerName: "pz" },
      rconService: { connected: true },
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "WIPE_SERVER_RUNNING" });
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("refuses with SERVER_STATE_UNKNOWN when nothing can tell whether a docker-local server is up", async () => {
    const res = await runWipe({
      server: { id: "s1", provider: "docker-local", dockerContainerName: "pz" },
      rconService: { connected: false },
    });

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("still wipes a native server that every signal agrees is stopped", async () => {
    const res = await runWipe({ server: { id: "s1" }, rconService: { connected: false } });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(path.join(saveDir, "map"))).toBe(false);
  });
});
