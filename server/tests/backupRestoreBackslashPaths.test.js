import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { craftZip } from "./helpers/craftZip.js";

// Audit 2026-10-20: a zip made by Windows PowerShell 5.1's Compress-Archive
// names its entries "servertest\map_meta.bin". On Linux path.join() kept the
// backslash as part of ONE file name, so the restore found no world folder.
// Entry paths are now normalised to "/" before any containment check, and a
// "..\..\x" entry is still refused as the traversal it is (on every OS).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));
vi.mock("../routes/chunks.js", () => ({ invalidateMapFolderScan: vi.fn() }));

const { BackupService } = await import("../services/backupService.js");
const { extractArchiveToStaging, createRestoreStagingDir, normalizeZipEntryPath } = await import(
  "../services/backupRestoreExtract.js"
);
const unzip = await import("unzipper");

const SERVER_NAME = "servertest";
let root;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({ getServerProcessDetails: async () => ({ running: false, scanFailed: false }) });
  return service;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backslash-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("restore of a backslash-separated zip", () => {
  it("normalises separators", () => {
    expect(normalizeZipEntryPath("servertest\\map\\0_0.bin")).toBe("servertest/map/0_0.bin");
    expect(normalizeZipEntryPath("..\\..\\x")).toBe("../../x");
  });

  it("restores the world in its folder (PowerShell 5.1 Compress-Archive layout)", async () => {
    fs.writeFileSync(
      path.join(backupsPath, "uploaded-ps.zip"),
      craftZip([
        { path: "servertest\\", data: "" },
        { path: "servertest\\map_meta.bin", data: "RESTORED" },
        { path: "servertest\\map\\0_0.bin", data: "chunk" },
      ]),
    );
    const result = await createService().restoreBackup("uploaded-ps.zip", { createPreRestoreBackup: false });
    expect(result).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("RESTORED");
    expect(fs.readFileSync(path.join(savesPath, "map", "0_0.bin"), "utf8")).toBe("chunk");
    expect(fs.readdirSync(savesPath).sort()).toEqual(["map", "map_meta.bin"]);
  });

  it("still refuses traversal after normalising (..\\..\\x, mixed separators, a nested escape)", async () => {
    const parent = path.join(root, "Saves", "Multiplayer");
    const zip = path.join(backupsPath, "uploaded-slip.zip");
    fs.writeFileSync(
      zip,
      craftZip([
        { path: "servertest\\map_meta.bin", data: "RESTORED" },
        { path: "..\\..\\escape1.txt", data: "ESC1" },
        { path: "..\\../escape2.txt", data: "ESC2" },
        { path: "servertest\\sub\\..\\..\\..\\escape3.txt", data: "ESC3" },
        { path: "../escape4.txt", data: "ESC4" },
      ]),
    );

    const staging = createRestoreStagingDir(parent);
    await extractArchiveToStaging(unzip, zip, staging);
    for (const dir of [parent, path.dirname(parent), root, path.dirname(staging)]) {
      for (const name of ["escape1.txt", "escape2.txt", "escape3.txt", "escape4.txt"]) {
        expect(fs.existsSync(path.join(dir, name))).toBe(false);
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });

    // The whole restore refuses such an archive (the entries never landed,
    // so they fail verification) and leaves the live world alone.
    const result = await createService().restoreBackup("uploaded-slip.zip", { createPreRestoreBackup: false });
    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
  });

  it("never reads a file outside staging to verify a traversal entry", async () => {
    // A file that matches the traversal entry byte for byte sits exactly
    // where "..\x" points from staging: verification must not accept it.
    const parent = path.join(root, "Saves", "Multiplayer");
    fs.writeFileSync(path.join(parent, "planted.txt"), "SAME");
    fs.writeFileSync(
      path.join(backupsPath, "uploaded-planted.zip"),
      craftZip([
        { path: "servertest\\map_meta.bin", data: "RESTORED" },
        { path: "..\\planted.txt", data: "SAME" },
      ]),
    );
    const result = await createService().restoreBackup("uploaded-planted.zip", { createPreRestoreBackup: false });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/integrity/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
  });
});
