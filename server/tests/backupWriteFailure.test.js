import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// A write error on the archive's output stream (a full disk, an I/O error)
// fires 'error' and then 'close' on the stream. The 'close' handler used to
// ignore the failure: it renamed the truncated .zip.tmp to a real .zip,
// saved a backup record, logged backup_created, told Discord the backup was
// complete and then ran retention -- which, with backupMaxCount=1, deleted
// the last GOOD backup in favour of the truncated one. These tests inject a
// write error (and a locked final rename) and check nothing of that happens.

const injected = vi.hoisted(() => ({
  failWriteAfterBytes: null,
  renameFailures: 0,
  renameAttempts: 0,
  renameCode: "EBUSY",
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  const base = actual.default;

  function createWriteStream(target, ...rest) {
    const stream = base.createWriteStream(target, ...rest);
    const limit = injected.failWriteAfterBytes;
    if (limit === null || !String(target).endsWith(".zip.tmp")) return stream;
    let written = 0;
    const realWrite = stream._write.bind(stream);
    stream._writev = null;
    stream._write = (chunk, encoding, callback) => {
      written += chunk.length;
      if (written > limit) {
        const error = new Error("ENOSPC: no space left on device, write");
        error.code = "ENOSPC";
        error.errno = -28;
        error.syscall = "write";
        callback(error);
        return;
      }
      realWrite(chunk, encoding, callback);
    };
    return stream;
  }

  function renameSync(from, to) {
    if (String(from).endsWith(".zip.tmp")) {
      injected.renameAttempts++;
      if (injected.renameFailures > 0) {
        injected.renameFailures--;
        const error = new Error(`${injected.renameCode}: resource busy or locked, rename`);
        error.code = injected.renameCode;
        throw error;
      }
    }
    return base.renameSync(from, to);
  }

  const wrapped = { ...base, createWriteStream, renameSync };
  return { ...actual, ...wrapped, default: wrapped };
});

const logServerEvent = vi.fn(async () => {});
const addBackupRecord = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
  flushWrites: vi.fn(async () => {}),
}));

vi.mock("../services/backupRecords.js", () => ({
  addBackupRecord,
  removeBackupRecord: vi.fn(async () => {}),
  listBackupRecords: vi.fn(async () => []),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";
const OLD_BACKUP = `${SERVER_NAME}_2020-01-01T00-00-00-000.zip`;

let root;
let savesPath;
let backupsPath;

function createService({ maxBackups = 1 } = {}) {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.getSettings = async () => ({
    enabled: false,
    schedule: "0 */6 * * *",
    maxBackups,
    includeDb: false,
  });
  return service;
}

function recordingIo() {
  const events = [];
  const io = {
    to: () => ({ emit: (event, payload) => events.push({ event, payload }) }),
  };
  return { io, events };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-writefail-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(savesPath, { recursive: true });
  fs.mkdirSync(backupsPath, { recursive: true });
  // Incompressible content, so the zip is large enough to fail part-way.
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), crypto.randomBytes(256 * 1024));
  fs.writeFileSync(path.join(savesPath, "worldstats.txt"), crypto.randomBytes(256 * 1024));
  fs.writeFileSync(path.join(backupsPath, OLD_BACKUP), "GOOD OLD BACKUP");
  injected.failWriteAfterBytes = null;
  injected.renameFailures = 0;
  injected.renameAttempts = 0;
  injected.renameCode = "EBUSY";
  logServerEvent.mockClear();
  addBackupRecord.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function remainingBackupFiles() {
  return fs.readdirSync(backupsPath).sort();
}

describe("createBackup: a write error on the archive stream is a failed backup", () => {
  it("keeps the last good backup, leaves no .zip or .tmp, and reports nothing as created", async () => {
    injected.failWriteAfterBytes = 64 * 1024;
    const service = createService({ maxBackups: 1 });
    const discordBot = { sendEventNotification: vi.fn(async () => {}) };
    service.setDiscordBot(discordBot);
    const { io, events } = recordingIo();

    const result = await service.createBackup({ io });
    // Anything a buggy close handler still does happens after the rejection.
    await settle();

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/ENOSPC|no space/i);
    // The older backup survives retention (nothing succeeded, nothing pruned)
    // and the truncated archive is neither listed nor left behind as a .tmp.
    expect(remainingBackupFiles()).toEqual([OLD_BACKUP]);
    expect(fs.readFileSync(path.join(backupsPath, OLD_BACKUP), "utf8")).toBe(
      "GOOD OLD BACKUP",
    );
    expect(addBackupRecord).not.toHaveBeenCalled();
    expect(logServerEvent).not.toHaveBeenCalledWith("backup_created", expect.anything());
    expect(discordBot.sendEventNotification).not.toHaveBeenCalled();
    expect(service.lastBackup).toBeNull();

    const progress = events.filter((e) => e.event === "backup:progress").map((e) => e.payload);
    expect(progress.some((p) => p.phase === "complete")).toBe(false);
    expect(progress[progress.length - 1].phase).toBe("error");
  });

  it("does not let a following backup be blocked by the failed one", async () => {
    injected.failWriteAfterBytes = 64 * 1024;
    const service = createService({ maxBackups: 5 });
    expect((await service.createBackup({})).success).toBe(false);

    injected.failWriteAfterBytes = null;
    const second = await service.createBackup({});
    expect(second.success).toBe(true);
    expect(remainingBackupFiles()).toHaveLength(2);
    expect(addBackupRecord).toHaveBeenCalledTimes(1);
  });
});

describe("createBackup: the final rename into place", () => {
  it("retries a rename that an antivirus scan holds up for a moment", async () => {
    injected.renameFailures = 2;
    const service = createService({ maxBackups: 5 });

    const result = await service.createBackup({});

    expect(result.success).toBe(true);
    expect(injected.renameAttempts).toBe(3);
    expect(fs.existsSync(result.backup.path)).toBe(true);
    expect(remainingBackupFiles().some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("removes the temporary file and reports a failure when the rename never succeeds", async () => {
    injected.renameFailures = 100;
    const service = createService({ maxBackups: 1 });
    const discordBot = { sendEventNotification: vi.fn(async () => {}) };
    service.setDiscordBot(discordBot);

    const result = await service.createBackup({});
    await settle();

    expect(result.success).toBe(false);
    expect(injected.renameAttempts).toBeGreaterThan(1);
    expect(remainingBackupFiles()).toEqual([OLD_BACKUP]);
    expect(addBackupRecord).not.toHaveBeenCalled();
    expect(discordBot.sendEventNotification).not.toHaveBeenCalled();
  });

  it("does not retry an error that is not a transient lock", async () => {
    injected.renameFailures = 100;
    injected.renameCode = "ENOENT";
    const service = createService({ maxBackups: 5 });

    const result = await service.createBackup({});

    expect(result.success).toBe(false);
    expect(injected.renameAttempts).toBe(1);
    expect(remainingBackupFiles()).toEqual([OLD_BACKUP]);
  });
});
