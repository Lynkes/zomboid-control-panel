import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt, 2026-09-18 (backup-integrity round): scheduler.js's
// own scheduled-backup cron job refuses to fire while
// scheduler.restartInProgress is true (its own comment explains why: a
// restart's warning countdown + RCON save + quit + relaunch all mutate
// savesPath, potentially for minutes, so a backup taken in that window can
// archive a save mid-write -- "a corrupt or inconsistent snapshot that
// looks like a normal backup until someone tries to restore it"). That
// check lived ONLY inside the scheduler's own cron callback -- a manual
// "Create Backup Now" (routes/backup.js POST /create), or any other direct
// caller of createBackup(), had no such check and would happily archive the
// exact same mid-restart state, reporting success:true with an empty
// skippedFiles (a torn save isn't a vanished file -- nothing would ever
// notice). This proves the gap is closed by createBackup() itself refusing
// whenever the injected scheduler reports a restart in progress, the same
// way it already refuses during an in-progress restore.

const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";

let root;
let savesPath;
let backupsPath;

function writeWorld(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "map_meta.bin"), marker);
  fs.writeFileSync(path.join(dir, "worldstats.txt"), marker);
}

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({
    getServerProcessDetails: async () => ({
      running: false,
      scanFailed: false,
    }),
  });
  return service;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-vs-restart-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  writeWorld(savesPath, "LIVE");
  logServerEvent.mockReset();
  logServerEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createBackup() while a restart is in progress", () => {
  it("is refused, the same way a concurrent createBackup() is refused during an in-progress restore", async () => {
    const service = createService();
    service.setScheduler({ restartInProgress: true });

    const result = await service.createBackup();

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/restart.*progress/i);
    // No archive should have been attempted at all -- confirms this is a
    // refusal, not a backup that ran and merely reported failure afterward.
    expect(fs.readdirSync(backupsPath)).toEqual([]);
  });

  it("proceeds normally once the restart is no longer in progress", async () => {
    const service = createService();
    service.setScheduler({ restartInProgress: false });

    const result = await service.createBackup();

    expect(result.success).toBe(true);
    expect(fs.readdirSync(backupsPath).some((f) => f.endsWith(".zip"))).toBe(
      true,
    );
  });

  it("proceeds normally when no scheduler was ever injected (e.g. a throwaway BackupService in a test or script)", async () => {
    const service = createService();

    const result = await service.createBackup();

    expect(result.success).toBe(true);
  });
});
