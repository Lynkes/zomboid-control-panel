import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// cleanupOldBackups (automatic, unattended, runs on a schedule) must never
// prune an "uploaded-" archive -- see its own comment in backupService.js.
// deleteBackupsOlderThan (operator-initiated, explicit) deliberately does
// the opposite and includes uploads. This proves both halves of that
// asymmetry against a REAL, isolated temp directory (real fs, not a mock
// of listBackups), plus that normal pruning still actually prunes -- a fix
// that "passes" by pruning nothing is the exact failure mode this program
// keeps producing.

const settings = new Map();

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async (key) => settings.get(key),
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  logServerEvent: async () => {},
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord: async () => {},
  removeBackupRecord: async () => {},
  listBackupRecords: async () => [],
}));

// Seeded with a real directory before the dynamic import below: importing
// backupService.js pulls in utils/logger.js, which calls getDataPaths()
// and mkdirSyncs a logs dir at MODULE IMPORT TIME (top-level, before any
// beforeEach runs) -- so tmpDir must already be a real path at that first
// import, not just non-undefined later. beforeEach swaps in a fresh one
// per test for isolation.
let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-prune-seed-"));
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { BackupService } = await import("../services/backupService.js");

function writeBackup(backupsPath, name) {
  fs.writeFileSync(path.join(backupsPath, name), "dummy");
}

function names(backupsPath) {
  return fs.readdirSync(backupsPath).filter((f) => f.endsWith(".zip"));
}

describe("backup pruning: uploaded archives are exempt from automatic prune, not from an explicit one", () => {
  let service;
  let backupsPath;

  beforeEach(async () => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-prune-"));
    service = new BackupService();
    backupsPath = await service.getBackupsPath();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanupOldBackups: uploaded archives survive a prune that would have taken every plain backup", async () => {
    settings.set("backupMaxCount", 0); // force: keep zero plain backups
    writeBackup(backupsPath, "uploaded-important.zip");
    writeBackup(backupsPath, "uploaded-another.zip");
    writeBackup(backupsPath, "world_backup_1.zip");
    writeBackup(backupsPath, "world_backup_2.zip");
    writeBackup(backupsPath, "world_backup_3.zip");

    await service.cleanupOldBackups();

    const remaining = names(backupsPath);
    expect(remaining).toEqual(
      expect.arrayContaining(["uploaded-important.zip", "uploaded-another.zip"]),
    );
    expect(remaining.some((n) => n.startsWith("world_backup_"))).toBe(false);
  });

  it("cleanupOldBackups: panel-created backups are still pruned correctly when there are no uploads at all", async () => {
    settings.set("backupMaxCount", 1);
    writeBackup(backupsPath, "world_backup_1.zip");
    writeBackup(backupsPath, "world_backup_2.zip");
    writeBackup(backupsPath, "world_backup_3.zip");

    await service.cleanupOldBackups();

    expect(names(backupsPath)).toHaveLength(1);
  });

  it("deleteBackupsOlderThan: an explicit, operator-initiated cutoff DOES delete uploaded archives -- unlike the automatic prune above", async () => {
    writeBackup(backupsPath, "uploaded-important.zip");
    writeBackup(backupsPath, "world_backup_1.zip");

    // days = -1 puts the cutoff a day in the FUTURE, so every file that
    // exists right now counts as older than it -- a deterministic way to
    // force "everything gets deleted" without depending on real file
    // birthtimes, which Node can't rewrite portably.
    const result = await service.deleteBackupsOlderThan(-1);

    expect(result.deleted).toBe(2);
    expect(names(backupsPath)).toHaveLength(0);
  });

  it("deleteBackupsOlderThan: a cutoff nothing is older than deletes nothing, uploads included", async () => {
    writeBackup(backupsPath, "uploaded-important.zip");
    writeBackup(backupsPath, "world_backup_1.zip");

    const result = await service.deleteBackupsOlderThan(9999);

    expect(result.deleted).toBe(0);
    expect(names(backupsPath)).toHaveLength(2);
  });
});
