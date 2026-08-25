import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import archiver from "archiver";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { invalidateMapFolderScanMock } = vi.hoisted(() => ({
  invalidateMapFolderScanMock: vi.fn(),
}));
vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: invalidateMapFolderScanMock,
}));

const { BackupService } = await import("../services/backupService.js");
const { Open } = await import("unzipper");

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
  service.setServerManager({ checkServerRunning: async () => false });
  return service;
}

async function writeValidBackup(zipPath, marker) {
  const stagingWorld = path.join(root, "source", SERVER_NAME);
  writeWorld(stagingWorld, marker);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 0 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(stagingWorld, SERVER_NAME);
    archive.finalize();
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-restore-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  writeWorld(savesPath, "LIVE");
  invalidateMapFolderScanMock.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreBackup archive safety", () => {
  it("keeps the live save when the archive is corrupt", async () => {
    const corrupt = path.join(backupsPath, "corrupt.zip");
    // Valid zip signature, truncated body: fails partway through extraction.
    fs.writeFileSync(corrupt, Buffer.from("PK\u0003\u0004 truncated payload"));

    const result = await createService().restoreBackup("corrupt.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(savesPath, "map_meta.bin"))).toBe(true);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("LIVE");
  });

  it("keeps the live save when the archive holds no world folder", async () => {
    const emptyZip = path.join(backupsPath, "empty.zip");
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(emptyZip);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append("nothing to see", { name: "readme.txt" });
      archive.finalize();
    });

    const result = await createService().restoreBackup("empty.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("LIVE");
  });

  it("replaces the live save from a valid archive", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const result = await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(
      fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8"),
    ).toBe("RESTORED");
  });

  it("restores a world whose source archive has different nested folder names", async () => {
    const portable = path.join(backupsPath, "portable.zip");
    const nestedWorld = path.join(root, "source", "Saves", "Multiplayer", "DifferentName");
    writeWorld(nestedWorld, "PORTABLE");

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(portable);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(path.join(root, "source", "Saves"), "Saves");
      archive.finalize();
    });

    const result = await createService().restoreBackup("portable.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin"), "utf8")).toBe("PORTABLE");
  });

  it("invalidates chunks.js's cached map/ folder scan after a successful restore", async () => {
    // Regression: chunks.js's /chunks and /stats routes cache a scan of a
    // save's map/ folder for a few seconds (getMapFolderScan()'s TTL
    // backstop). A restore swaps the whole save in from the archive but has
    // no path to call into chunks.js's own explicit invalidation -- without
    // this, a page reload within the TTL window after a restore would show
    // chunk counts for the PRE-restore map/ contents.
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    const result = await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(true);
    expect(invalidateMapFolderScanMock).toHaveBeenCalledWith(
      path.join(savesPath, "map"),
    );
  });

  it("does not invalidate the map/ folder scan when the restore fails", async () => {
    const corrupt = path.join(backupsPath, "corrupt.zip");
    fs.writeFileSync(corrupt, Buffer.from("PK truncated payload"));

    const result = await createService().restoreBackup("corrupt.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(invalidateMapFolderScanMock).not.toHaveBeenCalled();
  });

  it("leaves no staging folder behind", async () => {
    const good = path.join(backupsPath, "good.zip");
    await writeValidBackup(good, "RESTORED");

    await createService().restoreBackup("good.zip", {
      createPreRestoreBackup: false,
    });

    const leftovers = fs
      .readdirSync(path.dirname(savesPath))
      .filter((name) => name.startsWith(".restore-staging-"));

    expect(leftovers).toEqual([]);
  });
});

describe("createBackup archive safety", () => {
  it("leaves no .tmp file behind after a successful backup, and lists a real .zip", async () => {
    const service = createService();

    const result = await service.createBackup({});

    expect(result.success).toBe(true);
    const files = fs.readdirSync(backupsPath);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files.some((f) => f.endsWith(".zip"))).toBe(true);
  });

  it("does not depend on readdir arrays while creating a backup", async () => {
    const service = createService();
    service.cleanupOldBackups = async () => {};
    const callbackReaddir = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
      args.at(-1)(new Error("readdir must not be used for backup traversal"));
    });
    const promiseReaddir = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValue(new Error("readdir must not be used for backup traversal"));

    try {
      const result = await service.createBackup({});
      expect(result.success).toBe(true);
      expect(fs.existsSync(result.backup.path)).toBe(true);
    } finally {
      callbackReaddir.mockRestore();
      promiseReaddir.mockRestore();
    }
  });

  it("includes every nested save entry in the archive", async () => {
    const nestedFiles = [
      "map/chunk.bin",
      "players/alpha/player.db",
      "vehicles/zone-1/vehicle.db",
    ];
    for (const relativePath of nestedFiles) {
      const filePath = path.join(savesPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, relativePath);
    }

    const result = await createService().createBackup({});
    const archive = await Open.file(result.backup.path);
    const entryNames = archive.files.map((entry) => entry.path);

    expect(result.success).toBe(true);
    expect(entryNames).toEqual(
      expect.arrayContaining([
        ...nestedFiles.map((relativePath) => `${SERVER_NAME}/${relativePath}`),
        "panel-server-snapshot.json",
      ]),
    );
  });

});

describe("deleteBackupsOlderThan result contract", () => {
  it("reports partial deletion failures as unsuccessful", async () => {
    const service = createService();
    service.listBackups = async () => [
      {
        name: "old-a.zip",
        created: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        name: "old-b.zip",
        created: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    service.deleteBackup = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "locked" });

    const result = await service.deleteBackupsOlderThan(1);

    expect(result).toEqual(
      expect.objectContaining({ success: false, deleted: 1, failed: 1 }),
    );
  });
});

describe("getBackupSnapshot", () => {
  it("reads the embedded panel server snapshot", async () => {
    const backupPath = path.join(backupsPath, "snapshot.zip");
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append(
        JSON.stringify({
          schemaVersion: 1,
          server: { name: SERVER_NAME },
          serverIni: { PVP: "false" },
        }),
        { name: "panel-server-snapshot.json" },
      );
      archive.finalize();
    });

    const result = await createService().getBackupSnapshot("snapshot.zip");

    expect(result).toEqual({
      success: true,
      snapshot: {
        schemaVersion: 1,
        server: { name: SERVER_NAME },
        serverIni: { PVP: "false" },
      },
    });
  });

  it("reports a legacy archive without a panel snapshot", async () => {
    await writeValidBackup(path.join(backupsPath, "legacy.zip"), "LEGACY");

    await expect(createService().getBackupSnapshot("legacy.zip")).resolves.toEqual({
      success: false,
      message: "This backup has no panel snapshot",
    });
  });
});
