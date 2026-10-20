import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { craftZip } from "./helpers/craftZip.js";

// Security audit 2026-10-20: "View snapshot" (GET /api/backup/:name/snapshot)
// inflated the whole panel-server-snapshot.json of the archive into memory
// (entry.buffer()), and an uploaded zip can hold anything under that name: a
// 400 KB upload inflated to 400 MB in one request. The entry is now read
// through a byte counter that stops past 1 MiB, counting the real inflated
// bytes -- the size the zip records can be forged.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));
vi.mock("../routes/chunks.js", () => ({ invalidateMapFolderScan: vi.fn() }));

const { BackupService, readZipEntryCapped, SNAPSHOT_MAX_BYTES, ZIP_ENTRY_TOO_LARGE } = await import(
  "../services/backupService.js"
);
const { ErrorCode } = await import("../utils/errorCodes.js");
const unzip = await import("unzipper");

const MiB = 1024 * 1024;
let backupsPath;

function service() {
  const s = new BackupService();
  s.getBackupsPath = async () => backupsPath;
  return s;
}

// What the auditor's mkbomb.py builds: whitespace (valid JSON padding) and a
// trailing {} so JSON.parse would accept the whole thing.
function bombBytes(size) {
  return Buffer.concat([Buffer.alloc(size, 0x20), Buffer.from("{}")]);
}

beforeEach(() => {
  backupsPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-snapshot-cap-"));
});
afterEach(() => {
  fs.rmSync(backupsPath, { recursive: true, force: true });
});

describe("getBackupSnapshot(): the snapshot is read up to 1 MiB", () => {
  it("refuses a 2 MiB snapshot with a coded error", async () => {
    fs.writeFileSync(
      path.join(backupsPath, "uploaded-bomb.zip"),
      craftZip([{ path: "panel-server-snapshot.json", data: bombBytes(2 * MiB) }]),
    );
    const result = await service().getBackupSnapshot("uploaded-bomb.zip");
    expect(result.success).toBe(false);
    expect(result.code).toBe(ErrorCode.BACKUP_SNAPSHOT_TOO_LARGE);
  });

  it("refuses a bomb whose zip records a tiny size, without inflating it all", async () => {
    // 64 MiB of spaces is ~64 KB deflated; both size fields say 100 bytes.
    fs.writeFileSync(
      path.join(backupsPath, "uploaded-liar.zip"),
      craftZip([{ path: "panel-server-snapshot.json", data: bombBytes(64 * MiB), declaredSize: 100 }]),
    );
    const started = Date.now();
    const result = await service().getBackupSnapshot("uploaded-liar.zip");
    expect(result.success).toBe(false);
    expect(result.code).toBe(ErrorCode.BACKUP_SNAPSHOT_TOO_LARGE);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops counting just past the cap, never holding the whole entry", async () => {
    const file = path.join(backupsPath, "liar.zip");
    fs.writeFileSync(file, craftZip([{ path: "x.json", data: bombBytes(64 * MiB), declaredSize: 10 }]));
    const concat = vi.spyOn(Buffer, "concat");
    await expect(readZipEntryCapped(unzip, file, "x.json", SNAPSHOT_MAX_BYTES)).rejects.toMatchObject({
      code: ZIP_ENTRY_TOO_LARGE,
    });
    const largest = Math.max(0, ...concat.mock.results.map((r) => (Buffer.isBuffer(r.value) ? r.value.length : 0)));
    concat.mockRestore();
    expect(largest).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });

  it("still reads a normal snapshot, and one exactly at the cap", async () => {
    const snapshot = { schemaVersion: 1, server: { name: "servertest" }, serverIni: { PVP: "false" } };
    fs.writeFileSync(
      path.join(backupsPath, "ok.zip"),
      craftZip([
        { path: "servertest/map_meta.bin", data: "x" },
        { path: "panel-server-snapshot.json", data: JSON.stringify(snapshot) },
      ]),
    );
    expect(await service().getBackupSnapshot("ok.zip")).toEqual({ success: true, snapshot });

    const file = path.join(backupsPath, "edge.zip");
    fs.writeFileSync(file, craftZip([{ path: "x.json", data: Buffer.alloc(SNAPSHOT_MAX_BYTES, 0x20) }]));
    expect((await readZipEntryCapped(unzip, file, "x.json", SNAPSHOT_MAX_BYTES)).length).toBe(SNAPSHOT_MAX_BYTES);
  });

  it("resolves null for a missing entry and rejects (no crash) for a file that is not a zip", async () => {
    const file = path.join(backupsPath, "ok.zip");
    fs.writeFileSync(file, craftZip([{ path: "a.txt", data: "a" }]));
    expect(await readZipEntryCapped(unzip, file, "missing.json", SNAPSHOT_MAX_BYTES)).toBeNull();

    const junk = path.join(backupsPath, "junk.zip");
    fs.writeFileSync(junk, "not a zip at all");
    await expect(readZipEntryCapped(unzip, junk, "x.json", SNAPSHOT_MAX_BYTES)).rejects.toBeTruthy();
  });
});
