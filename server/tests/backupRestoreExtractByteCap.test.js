import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { craftZip } from "./helpers/craftZip.js";

// Security audit 2026-10-20: the restore's free-space check summed the sizes
// the archive's central directory records, and the extraction then wrote
// whatever the entries really inflated to, with no counter: a few hundred KB
// of upload claiming "10 bytes" could fill the saves volume. The extraction
// now counts the bytes it writes, per entry and in total, against the
// recorded sizes (local header and central directory) and the free space.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));
vi.mock("../routes/chunks.js", () => ({ invalidateMapFolderScan: vi.fn() }));

const { BackupService } = await import("../services/backupService.js");
const { extractArchiveToStaging, createRestoreStagingDir } = await import("../services/backupRestoreExtract.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const unzip = await import("unzipper");

const MiB = 1024 * 1024;
const SERVER_NAME = "servertest";
let root;
let savesPath;
let backupsPath;
let parent;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({ getServerProcessDetails: async () => ({ running: false, scanFailed: false }) });
  return service;
}

function writeZip(name, entries) {
  const file = path.join(backupsPath, name);
  fs.writeFileSync(file, craftZip(entries));
  return file;
}

// Extracts with the limits a real restore computes, and reports the outcome
// and how many bytes landed in staging.
async function extractWithRealLimits(file) {
  const staging = createRestoreStagingDir(parent);
  const limits = await createService()._restoreExtractionLimits(unzip, file, parent);
  let error = null;
  try {
    await extractArchiveToStaging(unzip, file, staging, limits);
  } catch (e) {
    error = e;
  }
  const sizeOf = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, e) => sum + (e.isDirectory() ? sizeOf(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size),
      0,
    );
  const bytes = sizeOf(staging);
  fs.rmSync(staging, { recursive: true, force: true });
  return { error, bytes };
}

const zeros = (n) => Buffer.alloc(n, 0);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-extract-cap-"));
  parent = path.join(root, "Saves", "Multiplayer");
  savesPath = path.join(parent, SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("restore extraction counts the bytes it writes", () => {
  it("stops an entry that inflates past the size both headers record", async () => {
    const file = writeZip("uploaded-liar.zip", [
      { path: "servertest/map_meta.bin", data: "meta" },
      { path: "servertest/map_t.bin", data: zeros(8 * MiB), declaredSize: 10 },
    ]);
    const { error, bytes } = await extractWithRealLimits(file);
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_SIZE_MISMATCH);
    expect(bytes).toBeLessThan(MiB);
  });

  it("stops one whose local header has no sizes (data descriptor) and whose central directory lies", async () => {
    const file = writeZip("uploaded-dd-liar.zip", [
      { path: "servertest/map_meta.bin", data: "meta", dataDescriptor: true },
      { path: "servertest/map_t.bin", data: zeros(8 * MiB), declaredSize: 10, dataDescriptor: true },
    ]);
    const { error, bytes } = await extractWithRealLimits(file);
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_SIZE_MISMATCH);
    expect(bytes).toBeLessThan(MiB);
  });

  it("caps an entry the central directory does not list by the archive's recorded total", async () => {
    const file = writeZip("uploaded-hidden.zip", [
      { path: "servertest/map_meta.bin", data: "meta" },
      { path: "servertest/hidden.bin", data: zeros(8 * MiB), dataDescriptor: true, inCentralDirectory: false },
    ]);
    const { error, bytes } = await extractWithRealLimits(file);
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_SIZE_MISMATCH);
    expect(bytes).toBeLessThan(3 * MiB);
  });

  it("stops many entries that each stay within their slack but add up past the recorded total", async () => {
    const entries = [{ path: "servertest/map_meta.bin", data: "meta" }];
    for (let i = 0; i < 40; i++) {
      entries.push({ path: `servertest/map/${i}.bin`, data: zeros(60 * 1024), declaredSize: 1 });
    }
    const { error, bytes } = await extractWithRealLimits(writeZip("uploaded-many.zip", entries));
    expect(error?.errorCode).toBe(ErrorCode.BACKUP_ARCHIVE_SIZE_MISMATCH);
    expect(bytes).toBeLessThanOrEqual(MiB + 64 * 1024);
  });

  it("stops short of the free space, minus a margin, with the disk-space code", async () => {
    const file = writeZip("big.zip", [{ path: "servertest/map_t.bin", data: zeros(4 * MiB) }]);
    const staging = createRestoreStagingDir(parent);
    // Room for the 4 MiB, but not once the margin (a tenth of the free space
    // on a disk this full, 128 MB on a roomier one) is kept free.
    const freeBytes = 4 * MiB + 300 * 1024;
    await expect(
      extractArchiveToStaging(unzip, file, staging, { declaredSizes: null, declaredTotal: null, freeBytes }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.BACKUP_INSUFFICIENT_DISK_SPACE });
    expect(fs.statSync(path.join(staging, "servertest", "map_t.bin")).size).toBeLessThanOrEqual(freeBytes - freeBytes / 10);
  });

  it("extracts an honest archive in full, data descriptors and all", async () => {
    const file = writeZip("honest.zip", [
      { path: "servertest/", data: "" },
      { path: "servertest/map_meta.bin", data: "meta" },
      { path: "servertest/map_t.bin", data: zeros(3 * MiB), dataDescriptor: true },
      { path: "servertest/stored.bin", data: zeros(MiB), method: 0 },
    ]);
    const { error, bytes } = await extractWithRealLimits(file);
    expect(error).toBeNull();
    expect(bytes).toBe(4 + 3 * MiB + MiB);
  });

  it("refuses the whole restore with the code and leaves the live world alone", async () => {
    writeZip("uploaded-liar.zip", [
      { path: "servertest/map_meta.bin", data: "meta" },
      { path: "servertest/map_t.bin", data: zeros(8 * MiB), declaredSize: 10 },
    ]);
    const result = await createService().restoreBackup("uploaded-liar.zip", { createPreRestoreBackup: false });
    expect(result).toMatchObject({ success: false, code: ErrorCode.BACKUP_ARCHIVE_SIZE_MISMATCH });
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
    expect(fs.readdirSync(parent).filter((n) => n.startsWith(".restore-staging-"))).toEqual([]);
  });
});
