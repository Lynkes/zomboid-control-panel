import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PATHS-1, verifier pass (security sweep 2026-10-05): a remote server's data
// folder names a path on its own host, so the save-time data-folder rule
// (services/zomboidDataPath.js) leaves it alone. But backups and the
// console-log routes still used that folder on THIS computer: a technician
// (servers.manage) saved a remote server whose data folder was any folder
// here, and backups then created <folder>/backups and listed, downloaded and
// deleted the .zip files in it (only /create, /restore and /upload refused a
// remote server), while the console-log routes read, polled and truncated
// <folder>/server-console.txt. Nothing of a remote server's is on this
// computer: backups resolve no folder for one and refuse it by name, and the
// console-log routes report no file and refuse to clear one.
//
// Full stack through the real routers and the real, unmocked database layer
// (the suite's per-file temp data dir keeps it isolated), with the
// signed-in role injected as req.user.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: backupRouter } = await import("../routes/backup.js");
const { default: serverRouter } = await import("../routes/server.js");
const { BackupService } = await import("../services/backupService.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const STRAY_ZIP = "Victim_2026-01-01T00-00-00-000.zip";
const HOST_LOG_LINE = "a line from a file on this computer";

let baseUrl;
let httpServer;
let currentRole = "technician";
let root;
let hostDir;
let bareHostDir;
let realData;
let installDir;
let localId;
let remoteId;

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-remote-data-"));
  // A folder on this computer that was never a data folder, with a backups
  // folder and a server-console.txt of its own.
  hostDir = path.join(root, "unrelated-host-dir");
  // One with nothing for backups yet: resolving its backups folder made it.
  bareHostDir = path.join(root, "another-host-dir");
  realData = path.join(root, "RealData");
  installDir = path.join(root, "pz-install");
  for (const dir of [
    path.join(hostDir, "backups"),
    path.join(hostDir, "secret-project"),
    bareHostDir,
    path.join(realData, "Saves", "Multiplayer", "Victim"),
    path.join(realData, "backups"),
    installDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(hostDir, "backups", STRAY_ZIP), "PK\x03\x04not really a zip");
  fs.writeFileSync(path.join(hostDir, "server-console.txt"), `${HOST_LOG_LINE}\nERROR[1] boom\n`);
  fs.writeFileSync(path.join(bareHostDir, "private-notes.txt"), "not a PZ file\n");
  fs.writeFileSync(path.join(realData, "backups", STRAY_ZIP), "PK\x03\x04local backup");

  await db.initDatabase();
  const local = await db.createServer({
    name: "Local",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: realData,
    rconHost: "127.0.0.1",
    rconPort: 27996,
    rconPassword: "x",
  });
  localId = local.id;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.set("backupService", new BackupService());
  app.use("/api/servers", serversRouter);
  app.use("/api/backup", backupRouter);
  app.use("/api/server", serverRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // The way in: servers.manage saves a remote server whose data folder is a
  // folder on this computer. Remote records skip the save-time rule (the
  // path is on the other host), so this is stored as sent.
  const created = await call("POST", "/api/servers", {
    name: "Remote",
    serverName: "Victim",
    isRemote: true,
    zomboidDataPath: hostDir,
    rconHost: "10.0.0.2",
    rconPort: 27997,
    rconPassword: "x",
  });
  expect(created.status).toBe(201);
  remoteId = created.json.server.id;
  expect((await db.getServer(remoteId)).zomboidDataPath).toBe(hostDir);
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  currentRole = "technician";
  await db.updateServer(remoteId, { zomboidDataPath: hostDir, isRemote: true });
  await db.setActiveServer(remoteId);
});

describe("backups of a remote server whose data folder is a folder on this computer", () => {
  it("resolve no saves or backups folder here, and don't create one", async () => {
    await db.updateServer(remoteId, { zomboidDataPath: bareHostDir });
    const service = new BackupService();
    expect(await service.getBackupsPath()).toBeNull();
    expect(await service.getSavesPath()).toBeNull();
    expect(fs.existsSync(path.join(bareHostDir, "backups"))).toBe(false);
  });

  it("list none of the .zip files in that folder's backups", async () => {
    const service = new BackupService();
    expect(await service.listBackups()).toEqual([]);
    const listed = await call("GET", "/api/backup/list");
    expect(listed.status).toBe(200);
    expect(listed.json.backups).toEqual([]);
    expect(listed.text).not.toContain(STRAY_ZIP);
  });

  it("refuse to download, read or delete a backup by name, and leave the file alone", async () => {
    const download = await call("GET", `/api/backup/download/${STRAY_ZIP}`);
    expect(download.status).toBe(400);
    expect(download.json.code).toBe(ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE);
    expect(download.text).not.toContain("not really a zip");

    const snapshot = await call("GET", `/api/backup/${STRAY_ZIP}/snapshot`);
    expect(snapshot.status).toBe(400);
    expect(snapshot.json.code).toBe(ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE);

    const deleted = await call("DELETE", `/api/backup/${STRAY_ZIP}`);
    expect(deleted.status).toBe(400);
    expect(deleted.json.code).toBe(ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE);

    const older = await call("POST", "/api/backup/delete-older-than", { days: 1 });
    expect(older.status).toBe(400);
    expect(older.json.code).toBe(ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE);

    expect(fs.existsSync(path.join(hostDir, "backups", STRAY_ZIP))).toBe(true);
  });

  it("refuse a scheduled backup too (it reaches createBackup() without the route)", async () => {
    await db.updateServer(remoteId, { zomboidDataPath: bareHostDir });
    const result = await new BackupService().createBackup({});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not available for remote servers/);
    expect(fs.existsSync(path.join(bareHostDir, "backups"))).toBe(false);
  });

  it("still list, download and refuse nothing for a local server", async () => {
    await db.setActiveServer(localId);
    const listed = await call("GET", "/api/backup/list");
    expect(listed.status).toBe(200);
    expect(listed.json.backups.map((b) => b.name)).toEqual([STRAY_ZIP]);
    const download = await call("GET", `/api/backup/download/${STRAY_ZIP}`);
    expect(download.status).toBe(200);
    expect(download.text).toContain("local backup");
  });
});

describe("the console-log routes for a remote server whose data folder is a folder on this computer", () => {
  it("report no log rather than read that folder's server-console.txt", async () => {
    const log = await call("GET", "/api/server/console-log");
    expect(log.status).toBe(200);
    expect(log.json.exists).toBe(false);
    expect(log.text).not.toContain(HOST_LOG_LINE);
    expect(log.text).not.toContain(hostDir.replace(/\\/g, "\\\\"));

    const stream = await call("GET", "/api/server/console-log/stream?lastSize=0");
    expect(stream.status).toBe(200);
    expect(stream.json.exists).toBe(false);
    expect(stream.text).not.toContain(HOST_LOG_LINE);

    const errors = await call("GET", "/api/server/console-log/error-count");
    expect(errors.status).toBe(200);
    expect(errors.json.exists).toBe(false);
    expect(errors.json.count).toBe(0);
  });

  it("refuse to clear it, and leave the file as it was", async () => {
    const cleared = await call("POST", "/api/server/console-log/clear");
    expect(cleared.status).toBe(400);
    expect(cleared.json.code).toBe(ErrorCode.SERVER_CONSOLE_LOG_REMOTE_NOT_AVAILABLE);
    expect(fs.readFileSync(path.join(hostDir, "server-console.txt"), "utf-8")).toContain(HOST_LOG_LINE);
  });

  it("still read a local server's log", async () => {
    fs.writeFileSync(path.join(realData, "server-console.txt"), "SERVER STARTED\nlocal line\n");
    await db.setActiveServer(localId);
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.status).toBe(200);
    expect(log.json.exists).toBe(true);
    expect(log.json.lines).toContain("local line");
  });
});
