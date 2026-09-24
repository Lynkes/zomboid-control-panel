import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt round 19 (backup-read-paths-ownership): round 18's
// cross-server ownership fix (backupCrossServerOwnership.test.js) covered
// listBackups()/cleanupOldBackups()/restoreBackup()/deleteBackup() -- every
// WRITE or LIST path. It missed the two READ paths: GET /:name/snapshot
// (backupService.getBackupSnapshot()) and GET /download/:name (routes/
// backup.js, which builds the file path directly rather than going through
// a service method at all). Neither checked ownership, so an operator of
// one server sharing a backups/ folder with another (see round 18's own
// header comment for exactly when that happens) could read the panel
// snapshot embedded in, or download the full archive of, another server's
// backup -- just by knowing or guessing its filename (predictable:
// `${serverName}_${timestamp}.zip`). Both are fixed here by reusing the
// exact same _findForeignBackupOwner() helper deleteBackup()/
// restoreBackup() already use, with the same fail-open rule for a name
// matching no known server.

const getActiveServerMock = vi.fn();
const getServersMock = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServerMock(...args),
  getServers: (...args) => getServersMock(...args),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getLatestScheduleExecutionByCommand: vi.fn(async () => null),
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: vi.fn(async () => {}),
  removeBackupRecord: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

let root;
let sharedDataPath;
let serverA;
let serverB;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-read-ownership-"));
  sharedDataPath = path.join(root, "shared");
  fs.mkdirSync(sharedDataPath, { recursive: true });

  serverA = { id: "a", serverName: "ServerA", zomboidDataPath: sharedDataPath };
  serverB = { id: "b", serverName: "ServerB", zomboidDataPath: sharedDataPath };

  getActiveServerMock.mockReset();
  getServersMock.mockReset().mockResolvedValue([serverA, serverB]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeBackupFile(serverName, millis, dataPath = sharedDataPath) {
  const backupsDir = path.join(dataPath, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const ms = String(millis).padStart(3, "0");
  const filePath = path.join(backupsDir, `${serverName}_2026-09-18T00-00-00-${ms}.zip`);
  fs.writeFileSync(filePath, "zip-bytes");
  return filePath;
}

describe("backupService.getBackupSnapshot(): cross-server ownership", () => {
  it("refuses to read a snapshot from a backup belonging to another currently-colliding server", async () => {
    writeBackupFile("ServerB", 1);
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    const result = await service.getBackupSnapshot("ServerB_2026-09-18T00-00-00-001.zip");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/belongs to another server profile.*ServerB/i);
  });

  it("does not refuse the server's own backup (ownership check passes through to the real snapshot read)", async () => {
    writeBackupFile("ServerA", 1);
    getActiveServerMock.mockResolvedValue(serverA);

    const service = new BackupService();
    const result = await service.getBackupSnapshot("ServerA_2026-09-18T00-00-00-001.zip");

    // Not a real zip archive, so this fails at the unzip step, not at
    // ownership -- proving the ownership check let it through rather than
    // silently refusing it, without needing a real zip fixture.
    expect(result.success).toBe(false);
    expect(result.message).not.toMatch(/belongs to another server profile/i);
  });

  it("does not refuse when there is no real collision (distinct data paths, the normal case)", async () => {
    const ownDataPath = path.join(root, "own");
    fs.mkdirSync(ownDataPath, { recursive: true });
    const distinctServerA = { id: "a", serverName: "ServerA", zomboidDataPath: ownDataPath };
    getServersMock.mockResolvedValue([distinctServerA, serverB]);
    getActiveServerMock.mockResolvedValue(distinctServerA);
    writeBackupFile("ServerA", 1, ownDataPath);

    const service = new BackupService();
    const result = await service.getBackupSnapshot("ServerA_2026-09-18T00-00-00-001.zip");

    expect(result.message).not.toMatch(/belongs to another server profile/i);
  });
});

describe("GET /api/backup/download/:name: cross-server ownership", () => {
  function getRouteHandler(backupRouter, routePath, method) {
    const layer = backupRouter.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods[method],
    );
    // stack[0] is the requirePermission gate, stack[1] is the real handler.
    return layer.route.stack[1].handle;
  }

  function createResponse() {
    const response = { status: vi.fn(), json: vi.fn(), download: vi.fn() };
    response.status.mockReturnValue(response);
    return response;
  }

  it("refuses to download a backup belonging to another currently-colliding server (404, res.download never called)", async () => {
    writeBackupFile("ServerB", 1);
    getActiveServerMock.mockResolvedValue(serverA);

    const { default: backupRouter } = await import("../routes/backup.js");
    const handler = getRouteHandler(backupRouter, "/download/:name", "get");
    const service = new BackupService();
    const req = {
      params: { name: "ServerB_2026-09-18T00-00-00-001.zip" },
      app: { get: (key) => (key === "backupService" ? service : undefined) },
    };
    const res = createResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/belongs to another server profile.*ServerB/i),
      }),
    );
    expect(res.download).not.toHaveBeenCalled();
  });

  it("downloads the server's own backup normally (no false refusal)", async () => {
    const ownPath = writeBackupFile("ServerA", 1);
    getActiveServerMock.mockResolvedValue(serverA);

    const { default: backupRouter } = await import("../routes/backup.js");
    const handler = getRouteHandler(backupRouter, "/download/:name", "get");
    const service = new BackupService();
    const req = {
      params: { name: "ServerA_2026-09-18T00-00-00-001.zip" },
      app: { get: (key) => (key === "backupService" ? service : undefined) },
    };
    const res = createResponse();

    await handler(req, res);

    expect(res.download).toHaveBeenCalledWith(ownPath, "ServerA_2026-09-18T00-00-00-001.zip");
    expect(res.status).not.toHaveBeenCalledWith(404);
  });
});
