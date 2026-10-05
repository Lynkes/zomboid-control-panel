import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, H4: routes every role (or a role that can't
// change the server's folders) reads still answered with host details.
// c5412dc5 hid the disk folders from roles without diagnostics.manage or
// backups.manage; the same now goes for:
//   - GET /api/system/runtime's temporaryDirectory (os.tmpdir(), which names
//     the panel's account on Windows) -- every role's pages read it;
//   - GET /api/backup/status and /list's savesPath, backupsPath and each
//     backup's path -- a download-only or restore-only role picks backups
//     by name -- and the last scheduled attempt's raw error;
//   - GET /api/server/console-log (and /stream): server.world_events, which
//     the moderator role holds, and the game's console log is full of host
//     folders;
//   - GET /api/panel-bridge/ping, which any signed-in role may call, and
//     whose failure quotes the bridge folder.
// The roles that can act on those folders keep them.
//
// Round 2 (verifier): GET /api/server/steamcmd/detect (server.world_events)
// still handed a moderator the SteamCMD folder, and saved it as a setting;
// a failed rollback's message in GET /api/backup/status's lastRestore and in
// POST /api/backup/restore/:name's answer still named the save folder to a
// download-only or restore-only role.

const init = await import("../database/init.js");
const { default: systemRouter } = await import("../routes/system.js");
const { default: backupRouter } = await import("../routes/backup.js");
const { default: serverRouter } = await import("../routes/server.js");
const { default: panelBridgeRouter } = await import("../routes/panelBridge.js");
const { default: bridge } = await import("../services/panelBridge.js");
const { RESTORE_ROLLBACK_FAILED_PREFIX } = await import("../utils/restoreMessage.js");

const MARKER = `zcp-h4-${process.pid}`;
const DATA_DIR = path.join(os.tmpdir(), MARKER, "Zomboid");
const BACKUPS_DIR = "/srv/pz-data/Zomboid/backups";
const SAVES_DIR = "/srv/pz-data/Zomboid/Saves/Multiplayer/servertest";
const BACKUP = { name: "servertest_2026-10-05.zip", path: `${BACKUPS_DIR}/servertest_2026-10-05.zip`, size: 10, created: "2026-10-05T00:00:00.000Z" };
const ROLLBACK_FAILED = `${RESTORE_ROLLBACK_FAILED_PREFIX} It is preserved at ${SAVES_DIR}_pre-restore-1759622400000.`;
let lastRestore = null;

const backupService = {
  getStatus: async () => ({
    enabled: false,
    schedule: "0 */6 * * *",
    backupInProgress: false,
    restoreInProgress: false,
    currentRestore: null,
    lastRestore,
    lastBackup: { ...BACKUP },
    backupCount: 1,
    savesPath: SAVES_DIR,
    backupsPath: BACKUPS_DIR,
    savesExists: true,
    lastScheduledBackupAttempt: {
      success: false,
      message: `Saves folder not found: ${SAVES_DIR}`,
      messageKey: null,
      messageParams: null,
      executedAt: "2026-10-05T00:00:00.000Z",
      skipReason: null,
      recoveredAt: null,
    },
  }),
  listBackups: async () => [{ ...BACKUP }],
  restoreBackup: async () => ({ success: false, message: ROLLBACK_FAILED }),
};
const serverManager = {
  getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
};

let baseUrl;
let httpServer;
let currentRole = "moderator";

async function getJson(url) {
  const res = await fetch(baseUrl + url);
  expect(res.status, url).toBe(200);
  return res.json();
}

beforeAll(async () => {
  await init.initDatabase();
  await init.insertRole({ id: "role-h4-downloader", name: "h4-downloader", capabilities: ["backups.download"] });
  await init.insertRole({ id: "role-h4-diagnostics", name: "h4-diagnostics", capabilities: ["diagnostics.manage"] });
  await init.insertRole({ id: "role-h4-restorer", name: "h4-restorer", capabilities: ["backups.restore"] });
  await init.insertRole({
    id: "role-h4-settings",
    name: "h4-settings",
    capabilities: ["panel.settings", "server.world_events"],
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "server-console.txt"),
    [
      "LOG  : General     , 1> version=42.12.0 demo=false",
      `LOG  : General     , 1> cachedir set to "${DATA_DIR}"`,
      "LOG  : General     , 1> Loading mod /srv/pz-install/steamapps/workshop/content/108600/2392709985/mods/Better",
      "LOG  : General     , 1> SERVER STARTED",
      "",
    ].join("\n"),
  );
  const server = await init.createServer({ name: "H4", serverName: "servertest", zomboidDataPath: DATA_DIR });
  await init.setActiveServer(server.id);

  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("backupService", backupService);
  app.set("serverManager", serverManager);
  app.set("io", null);
  app.set("scheduler", null);
  app.use("/api/system", systemRouter);
  app.use("/api/backup", backupRouter);
  app.use("/api/server", serverRouter);
  app.use("/api/panel-bridge", panelBridgeRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(path.join(os.tmpdir(), MARKER), { recursive: true, force: true });
});

function expectNoHostPath(body) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain("/srv/pz-");
}

describe("GET /api/system/runtime", () => {
  for (const role of ["moderator", "technician"]) {
    it(`gives ${role} the runtime without the temp folder`, async () => {
      currentRole = role;
      const runtime = await getJson("/api/system/runtime");
      expect(runtime.temporaryDirectory).toBeNull();
      expect(runtime.platform).toBe(process.platform);
      expect(runtime.restartAssessment).toBeTruthy();
    });
  }

  for (const role of ["admin", "h4-diagnostics"]) {
    it(`gives ${role} the temp folder`, async () => {
      currentRole = role;
      expect((await getJson("/api/system/runtime")).temporaryDirectory).toBe(os.tmpdir());
    });
  }
});

describe("GET /api/backup/status and /list", () => {
  it("give a download-only role the backups without any folder", async () => {
    currentRole = "h4-downloader";
    const status = await getJson("/api/backup/status");
    expect(status.savesPath).toBeNull();
    expect(status.backupsPath).toBeNull();
    expect(status.lastBackup).toMatchObject({ name: BACKUP.name, size: 10, path: null });
    expect(status.lastScheduledBackupAttempt.message).toBe("Saves folder not found: [path]");
    expect(status.savesExists).toBe(true);
    expectNoHostPath(status);

    const list = await getJson("/api/backup/list");
    expect(list.backups).toEqual([{ ...BACKUP, path: null }]);
  });

  it("give backups.manage the folders", async () => {
    currentRole = "technician";
    const status = await getJson("/api/backup/status");
    expect(status.savesPath).toBe(SAVES_DIR);
    expect(status.backupsPath).toBe(BACKUPS_DIR);
    expect(status.lastBackup.path).toBe(BACKUP.path);
    expect((await getJson("/api/backup/list")).backups[0].path).toBe(BACKUP.path);
  });
});

describe("a failed rollback's message (GET /api/backup/status's lastRestore, POST /api/backup/restore/:name)", () => {
  beforeAll(() => {
    lastRestore = {
      id: "restore-h4",
      backupName: BACKUP.name,
      startedAt: "2026-10-05T00:00:00.000Z",
      preRestoreBackup: true,
      finishedAt: "2026-10-05T00:01:00.000Z",
      success: false,
      message: ROLLBACK_FAILED,
      duration: null,
    };
  });

  afterAll(() => {
    lastRestore = null;
  });

  it("names no folder to a download-only role", async () => {
    currentRole = "h4-downloader";
    const status = await getJson("/api/backup/status");
    expect(status.lastRestore).toMatchObject({ id: "restore-h4", success: false });
    expect(status.lastRestore.message).toBe(`${RESTORE_ROLLBACK_FAILED_PREFIX} It is preserved at [path]`);
    expectNoHostPath(status);
  });

  it("names no folder to the restore-only role that ran it", async () => {
    currentRole = "h4-restorer";
    const res = await fetch(`${baseUrl}/api/backup/restore/${BACKUP.name}`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe(`${RESTORE_ROLLBACK_FAILED_PREFIX} It is preserved at [path]`);
    expectNoHostPath(body);
  });

  it("keeps the folder for the roles that can go and get the save", async () => {
    currentRole = "technician";
    expect((await getJson("/api/backup/status")).lastRestore.message).toBe(ROLLBACK_FAILED);
    currentRole = "admin";
    const res = await fetch(`${baseUrl}/api/backup/restore/${BACKUP.name}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(ROLLBACK_FAILED);
  });
});

describe("GET /api/server/steamcmd/detect", () => {
  const steamcmdDir = path.join(os.tmpdir(), MARKER, "steamcmd");
  const exeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
  let previousEnv;

  beforeAll(async () => {
    fs.mkdirSync(steamcmdDir, { recursive: true });
    for (const name of ["steamcmd.exe", "steamcmd.sh"]) fs.writeFileSync(path.join(steamcmdDir, name), "");
    previousEnv = process.env.STEAMCMD_PATH;
    process.env.STEAMCMD_PATH = steamcmdDir;
    await init.setSetting("steamcmdPath", "");
  });

  afterAll(() => {
    if (previousEnv === undefined) delete process.env.STEAMCMD_PATH;
    else process.env.STEAMCMD_PATH = previousEnv;
  });

  it("tells a moderator (server.world_events) only that SteamCMD was found, and saves nothing", async () => {
    currentRole = "moderator";
    const body = await getJson("/api/server/steamcmd/detect");
    expect(body).toEqual({ found: true, message: "SteamCMD found automatically" });
    expectNoHostPath(body);
    expect(await init.getSetting("steamcmdPath")).toBeFalsy();
  });

  it("shows the folder to a role that sets folders up but saves it only for server.install", async () => {
    currentRole = "h4-settings";
    expect(await getJson("/api/server/steamcmd/detect")).toMatchObject({ found: true, path: steamcmdDir });
    expect(await init.getSetting("steamcmdPath")).toBeFalsy();

    currentRole = "technician";
    expect(await getJson("/api/server/steamcmd/detect")).toEqual({
      found: true,
      path: steamcmdDir,
      executable: path.join(steamcmdDir, exeName),
      message: "SteamCMD found automatically",
    });
    expect(await init.getSetting("steamcmdPath")).toBe(steamcmdDir);
  });
});

describe("GET /api/server/console-log", () => {
  it("gives a moderator (server.world_events) the lines path-redacted and only the file name", async () => {
    currentRole = "moderator";
    const log = await getJson("/api/server/console-log?filter=all");
    expect(log.path).toBe("server-console.txt");
    expect(log.lines.some((line) => line.includes("SERVER STARTED"))).toBe(true);
    expect(log.lines.some((line) => line.includes('cachedir set to "[path]"'))).toBe(true);
    expectNoHostPath(log);

    const stream = await getJson("/api/server/console-log/stream?filter=all&lastSize=0");
    expect(stream.newLines.length).toBeGreaterThan(0);
    expectNoHostPath(stream);
  });

  it("gives a role that sets the server's folders up (servers.manage) the log as written", async () => {
    currentRole = "technician";
    const log = await getJson("/api/server/console-log?filter=all");
    expect(log.path).toBe(path.join(DATA_DIR, "server-console.txt"));
    expect(log.content).toContain(DATA_DIR);
  });
});

describe("GET /api/panel-bridge/ping", () => {
  it("redacts the bridge folder from a failed ping", async () => {
    currentRole = "moderator";
    const previousPath = bridge.bridgePath;
    bridge.bridgePath = path.join(DATA_DIR, "Lua", "ZCPB");
    const ping = vi.spyOn(bridge, "ping").mockResolvedValue({
      success: false,
      error: `EACCES: permission denied, open '${path.join(DATA_DIR, "Lua", "ZCPB", "commands.json")}'`,
    });
    try {
      const body = await getJson("/api/panel-bridge/ping");
      expect(body).toEqual({ success: false, error: "EACCES: permission denied, open '[path]'" });
    } finally {
      ping.mockRestore();
      bridge.bridgePath = previousPath;
    }
  });
});
