import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// getSavesPath() used to fall back, when Saves/Multiplayer/<serverName> was
// missing, to the alphabetically first folder there. That folder could be
// another server's world: a backup then archived it under this server's name,
// and a RESTORE replaced it. A different folder now stands in only when it can
// be attributed to this server.

const { warnCalls, mockLogger } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: {
      info: () => {},
      warn: (msg) => warnCalls.push(String(msg)),
      error: () => {},
      debug: () => {},
    },
  };
});

vi.mock("../utils/logger.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createLogger: (name) => (name === "Backup" ? mockLogger : real.createLogger(name)),
  };
});

const db = await import("../database/init.js");
const { BackupService } = await import("../services/backupService.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { isFirstBootMissingAdminPassword } = await import("../routes/server.js");

let root;
let installDir;
let dataDir;
let multiplayer;
let alphaId;
let betaId;

function world(name) {
  const dir = path.join(multiplayer, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "map_t.bin"), name);
  return dir;
}

function clearWorlds() {
  fs.rmSync(multiplayer, { recursive: true, force: true });
  fs.mkdirSync(multiplayer, { recursive: true });
}

async function useNames(alpha, beta) {
  await db.updateServer(alphaId, { serverName: alpha });
  await db.updateServer(betaId, { serverName: beta });
  await db.setActiveServer(alphaId);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-saves-resolve-"));
  installDir = path.join(root, "pz-install");
  dataDir = path.join(root, "Zomboid");
  multiplayer = path.join(dataDir, "Saves", "Multiplayer");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(multiplayer, { recursive: true });

  await db.initDatabase();
  const alpha = await db.createServer({
    name: "Alpha",
    serverName: "Alpha",
    installPath: installDir,
    zomboidDataPath: dataDir,
    rconHost: "127.0.0.1",
    rconPort: 27991,
    rconPassword: "x",
  });
  const beta = await db.createServer({
    name: "Beta",
    serverName: "Beta",
    installPath: installDir,
    zomboidDataPath: dataDir,
    rconHost: "127.0.0.1",
    rconPort: 27992,
    rconPassword: "x",
  });
  alphaId = alpha.id;
  betaId = beta.id;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  clearWorlds();
  warnCalls.length = 0;
  await useNames("Alpha", "Beta");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getSavesPath() when the server's own world folder is missing", () => {
  it("returns the server's own folder when it exists", async () => {
    const own = world("Alpha");
    world("Beta");
    expect(await new BackupService().getSavesPath()).toBe(own);
  });

  it("does not hand over another profile's world (the alphabetically first folder)", async () => {
    world("Beta");
    const result = await new BackupService().getSavesPath();
    expect(result).toBe(path.join(multiplayer, "Alpha"));
    expect(fs.existsSync(result)).toBe(false);
  });

  it("does not guess among several unrelated folders", async () => {
    world("Aardvark");
    world("Zulu");
    expect(await new BackupService().getSavesPath()).toBe(path.join(multiplayer, "Alpha"));
  });

  it("takes the one folder that matches by letters and digits when no other profile owns it", async () => {
    await useNames("AU-NZ Auckland PvE", "Beta");
    const spelled = world("AU-NZ_Auckland_PvE");
    world("Beta");
    expect(await new BackupService().getSavesPath()).toBe(spelled);
  });

  it("refuses a match by letters and digits that another profile's name also maps to", async () => {
    await useNames("Survival-Hard", "Survival Hard");
    world("Survival Hard");
    const result = await new BackupService().getSavesPath();
    expect(result).toBe(path.join(multiplayer, "Survival-Hard"));
  });

  it("refuses a match by letters and digits when two folders match it", async () => {
    await useNames("Survival-Hard", "Beta");
    world("Survival Hard");
    world("Survival_Hard");
    expect(await new BackupService().getSavesPath()).toBe(path.join(multiplayer, "Survival-Hard"));
  });

  it("takes the only world folder when no other profile is named for it", async () => {
    const lone = world("OldWorldName");
    expect(await new BackupService().getSavesPath()).toBe(lone);
  });

  it("does not take the only world folder when another profile is named for it", async () => {
    world("Beta");
    expect(await new BackupService().getSavesPath()).toBe(path.join(multiplayer, "Alpha"));
    // however Beta's name is spelled
    await useNames("Alpha", "be-ta");
    expect(await new BackupService().getSavesPath()).toBe(path.join(multiplayer, "Alpha"));
  });

  it("does not take the only world folder when the other profiles cannot be read", async () => {
    world("OldWorldName");
    const spy = vi.spyOn(db, "getServers").mockRejectedValue(new Error("db down"));
    try {
      expect(await new BackupService().getSavesPath()).toBe(path.join(multiplayer, "Alpha"));
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores a profile that keeps its data elsewhere", async () => {
    const elsewhere = path.join(root, "OtherZomboid");
    fs.mkdirSync(path.join(elsewhere, "Saves", "Multiplayer", "Beta"), { recursive: true });
    await db.updateServer(betaId, { zomboidDataPath: elsewhere, serverName: "OldWorldName" });
    try {
      const lone = world("OldWorldName");
      expect(await new BackupService().getSavesPath()).toBe(lone);
    } finally {
      await db.updateServer(betaId, { zomboidDataPath: dataDir });
    }
  });

  it("has no world to find when Saves/Multiplayer is missing", async () => {
    fs.rmSync(multiplayer, { recursive: true, force: true });
    expect(await new BackupService().getSavesPath()).toBe(path.join(multiplayer, "Alpha"));
  });
});

describe("a backup with no folder of the server's own", () => {
  it("fails with a coded error instead of archiving another server's world", async () => {
    world("Beta");
    const service = new BackupService();
    const result = await service.createBackup({});
    expect(result.success).toBe(false);
    expect(result.code).toBe(ErrorCode.BACKUP_SAVES_FOLDER_NOT_FOUND);
    const backupsPath = path.join(dataDir, "backups");
    const archives = fs.existsSync(backupsPath)
      ? fs.readdirSync(backupsPath).filter((n) => n.endsWith(".zip"))
      : [];
    expect(archives).toEqual([]);
  });
});

describe("the warning about a folder that cannot be matched", () => {
  it("is logged once an hour per name, not on every status poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    world("Aardvark");
    world("Zulu");
    const service = new BackupService();
    const unmatched = () => warnCalls.filter((m) => m.includes("can be attributed to server"));

    for (let i = 0; i < 25; i += 1) await service.getSavesPath();
    expect(unmatched()).toHaveLength(1);

    vi.setSystemTime(new Date("2031-01-01T00:30:00Z"));
    await service.getSavesPath();
    expect(unmatched()).toHaveLength(1);

    vi.setSystemTime(new Date("2031-01-01T01:00:01Z"));
    await service.getSavesPath();
    await service.getSavesPath();
    expect(unmatched()).toHaveLength(2);
  });

  it("is logged once an hour for a stand-in folder too", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2032-01-01T00:00:00Z"));
    await useNames("Standin-Server", "Beta");
    world("Standin_Server");
    const service = new BackupService();
    for (let i = 0; i < 10; i += 1) await service.getSavesPath();
    expect(warnCalls.filter((m) => m.includes("Standin_Server"))).toHaveLength(1);
  });
});

describe("isFirstBootMissingAdminPassword() with a world folder spelled differently", () => {
  const server = (serverName) => ({
    serverName,
    zomboidDataPath: dataDir,
    adminPassword: "",
    isRemote: false,
  });

  it("still calls a server with no world at all a first boot", () => {
    expect(isFirstBootMissingAdminPassword(server("Alpha"))).toBe(true);
    world("Beta");
    expect(isFirstBootMissingAdminPassword(server("Alpha"))).toBe(true);
  });

  it("does not refuse a start whose world folder differs only in letter case or punctuation", () => {
    world("AU-NZ_Auckland_PvE");
    expect(isFirstBootMissingAdminPassword(server("AU-NZ Auckland PvE"))).toBe(false);
    expect(isFirstBootMissingAdminPassword(server("au-nz auckland pve"))).toBe(false);
  });
});
