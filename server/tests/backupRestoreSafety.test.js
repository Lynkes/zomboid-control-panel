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
