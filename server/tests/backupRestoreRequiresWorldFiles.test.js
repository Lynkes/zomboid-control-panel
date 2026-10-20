import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { craftZip } from "./helpers/craftZip.js";

// Audit 2026-10-20: _findExtractedWorld() returned <staging>/<server name> as
// soon as that folder existed, without checking it held a world, so an
// archive with only servertest/readme.txt replaced the live world with a
// folder holding a readme. The folder named like the server now has to hold
// world files (map_meta.bin or map_t.bin) too; otherwise the usual search for
// a world elsewhere in the archive runs.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));
vi.mock("../routes/chunks.js", () => ({ invalidateMapFolderScan: vi.fn() }));

const { BackupService } = await import("../services/backupService.js");

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

async function restore(name, entries) {
  fs.writeFileSync(path.join(backupsPath, name), craftZip(entries));
  return createService().restoreBackup(name, { createPreRestoreBackup: false });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-world-files-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("restore needs world files in the folder it swaps in", () => {
  it("refuses an archive whose server-named folder holds no world", async () => {
    const result = await restore("uploaded-readme.zip", [{ path: "servertest/readme.txt", data: "hello" }]);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/did not contain a world save folder/i);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("LIVE");
  });

  it("takes the real world over a junk folder named like the server", async () => {
    const result = await restore("uploaded-mixed.zip", [
      { path: "servertest/readme.txt", data: "junk" },
      { path: "oldname/map_t.bin", data: "REAL" },
    ]);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_t.bin"), "utf8")).toBe("REAL");
    expect(fs.existsSync(path.join(savesPath, "readme.txt"))).toBe(false);
  });

  it("still restores the server-named folder when it holds a world", async () => {
    const result = await restore("good.zip", [
      { path: "servertest/map_meta.bin", data: "RESTORED" },
      { path: "other/map_meta.bin", data: "OTHER" },
    ]);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("RESTORED");
  });
});
