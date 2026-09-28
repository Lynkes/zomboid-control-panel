import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import {
  CLIENT_COMPANION,
  MOD,
  WS_ID,
  bundledLua,
  createRoot,
  createServerFiles,
  looseServerPath,
  makeServer,
  readText,
  snapshotFiles,
  writeLoose,
} from "./helpers/bridgeDeliveryFixtures.js";

// I4 and I6 in practice: the order of the file steps, and that a failure at
// ANY step leaves the ini bytes, the loose files and the stored method exactly
// as they were (restored: true), so a failed switch never strands a server
// that can't be joined.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));
const trace = vi.hoisted(() => ({ order: [], iniWrites: 0, failIniWriteAt: null, corruptIniWriteAt: null, failArchive: false, failInstall: false }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  const impl = dbMockImplementation(dbState);
  return {
    ...impl,
    updateServer: async (...args) => {
      trace.order.push("persist");
      return impl.updateServer(...args);
    },
  };
});
vi.mock("../utils/serverStatus.js", () => ({ resolveObservedServerRunning: vi.fn(async () => false) }));
vi.mock("../utils/configBackup.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeIniWithBackup: async (iniPath, content) => {
      trace.iniWrites += 1;
      trace.order.push("ini");
      if (trace.failIniWriteAt === trace.iniWrites) throw new Error("disk full");
      const result = await actual.writeIniWithBackup(iniPath, content);
      if (trace.corruptIniWriteAt === trace.iniWrites) fs.writeFileSync(iniPath, "garbage=1\n");
      return result;
    },
  };
});
vi.mock("../services/bridgeDisk.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    archiveLooseBridgeFiles: async (installDir, files, options) => {
      if (options?.reason === "switch-to-workshop") {
        trace.order.push("archive");
        if (trace.failArchive) {
          const error = new Error("EPERM");
          error.fileName = "PanelBridge.lua";
          throw error;
        }
      }
      return actual.archiveLooseBridgeFiles(installDir, files, options);
    },
  };
});
vi.mock("../services/panelBridgeInstaller.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    installBridge: (server) => {
      trace.order.push("install");
      if (trace.failInstall) return { success: false, error: "EACCES" };
      return actual.installBridge(server);
    },
  };
});

const { applyDeliverySwitch } = await import("../services/bridgeDelivery.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

let root;
let one;
let two;
const deps = { serverManager: { startTime: null }, bridge: { getStatus: () => ({ modStatus: { alive: true, startedAt: 4242 } }) } };

function seedGroup({ workshop = false } = {}) {
  one = createServerFiles(root, { key: "s1" });
  two = createServerFiles(root, { key: "s2", serverName: "second", installDir: one.installDir });
  const record = workshop
    ? { bridgeDelivery: "workshop", bridgeDeliverySwitch: { to: "workshop", at: "2026-01-01T00:00:00.000Z", by: "a", bridgeStartedAt: 1, workshopId: WS_ID } }
    : {};
  if (workshop) {
    fs.writeFileSync(one.iniPath, `Mods=A;${MOD}\r\nWorkshopItems=1;${WS_ID}\r\nDoLuaChecksum=true\r\n`);
    fs.writeFileSync(two.iniPath, `Mods=${MOD}\r\nWorkshopItems=${WS_ID}\r\n`);
  }
  dbState.servers = [
    makeServer(one, { id: "s1", name: "One", ...record }),
    makeServer(two, { id: "s2", name: "Two", serverName: "second", isActive: false, ...record }),
  ];
}

function trackedPaths() {
  return [
    one.iniPath,
    two.iniPath,
    looseServerPath(one.installDir),
    `${one.installDir}/media/lua/client/PanelBridgeClient.lua`,
  ];
}

beforeEach(() => {
  root = createRoot();
  Object.assign(trace, { order: [], iniWrites: 0, failIniWriteAt: null, corruptIniWriteAt: null, failArchive: false, failInstall: false });
  dbState.failUpdate = false;
  dbState.failCommit = false;
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("switch to Workshop", () => {
  beforeEach(() => {
    seedGroup();
    writeLoose(one.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    writeLoose(one.installDir, "media/lua/client/PanelBridgeClient.lua", CLIENT_COMPANION);
  });

  it("writes and verifies every group ini, then archives, then persists the method on every profile", async () => {
    const result = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", actor: "admin", deps });

    expect(trace.order).toEqual(["ini", "ini", "archive", "persist", "persist"]);
    expect(result).toMatchObject({ applied: true, from: "local", to: "workshop" });
    expect(result.backups).toHaveLength(2);
    expect(result.backups[0]).toMatchObject({ file: one.iniPath, backupName: expect.stringMatching(/^servertest\.ini\./) });
    expect(readText(one.iniPath)).toBe(`PVP=true\nMods=OtherMod;${MOD}\nWorkshopItems=111;${WS_ID}\nDoLuaChecksum=true\n`);
    expect(readText(two.iniPath)).toContain(`Mods=OtherMod;${MOD}`);
    expect(fs.existsSync(looseServerPath(one.installDir))).toBe(false);
    for (const server of dbState.servers) {
      expect(server.bridgeDelivery).toBe("workshop");
      expect(server.bridgeDeliverySwitch).toMatchObject({ to: "workshop", by: "admin", bridgeStartedAt: 4242, workshopId: WS_ID });
    }
    // I5: the switch never turns the Lua integrity check on or off here.
    expect(readText(one.iniPath)).toContain("DoLuaChecksum=true");
    expect(result.status).toMatchObject({ method: "workshop", state: "workshop-restart-needed" });
  });

  it.each([
    ["the first ini write", () => { trace.failIniWriteAt = 1; }, "PANELBRIDGE_DELIVERY_INI_WRITE_FAILED"],
    ["the second ini write", () => { trace.failIniWriteAt = 2; }, "PANELBRIDGE_DELIVERY_INI_WRITE_FAILED"],
    ["an ini that reads back wrong", () => { trace.corruptIniWriteAt = 2; }, "PANELBRIDGE_DELIVERY_INI_WRITE_FAILED"],
    ["the archive", () => { trace.failArchive = true; }, "PANELBRIDGE_DELIVERY_FILE_ARCHIVE_FAILED"],
    ["recording the method", () => { dbState.failUpdate = true; }, undefined],
    ["committing the database", () => { dbState.failCommit = true; }, undefined],
  ])("a failure at %s restores every file and the database", async (_label, inject, code) => {
    const files = snapshotFiles(trackedPaths());
    const db = JSON.stringify(dbState.servers);
    inject();

    const error = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch((e) => e);

    expect(error).toMatchObject({ restored: true });
    if (code) expect(error.code).toBe(code);
    else expect(error.status).toBe(500);
    dbState.failUpdate = false;
    dbState.failCommit = false;
    expect(snapshotFiles(trackedPaths())).toEqual(files);
    expect(JSON.stringify(dbState.servers)).toBe(db);
  });

  it("the ini-write error names the file by basename only", async () => {
    trace.failIniWriteAt = 2;
    const error = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch((e) => e);
    expect(error.params).toEqual({ fileName: "second.ini" });
  });
});

describe("switch to Local", () => {
  beforeEach(() => seedGroup({ workshop: true }));

  it("installs and verifies the loose file first, then one write per ini, then persists", async () => {
    const result = await applyDeliverySwitch(dbState.servers[0], "local", { expectedFrom: "workshop", deps });

    expect(trace.order).toEqual(["install", "ini", "ini", "persist", "persist"]);
    expect(fs.readFileSync(looseServerPath(one.installDir), "utf8")).toBe(bundledLua());
    expect(readText(one.iniPath)).toBe("Mods=A\nWorkshopItems=1\nDoLuaChecksum=false\n");
    expect(readText(two.iniPath)).toBe("Mods=\nWorkshopItems=\nDoLuaChecksum=false\n");
    expect(dbState.servers.map((s) => s.bridgeDelivery)).toEqual(["local", "local"]);
    expect(dbState.servers[0].bridgeDeliverySwitch).toMatchObject({ to: "local", workshopId: null });
    expect(result.status).toMatchObject({ method: "local", state: "local-ok" });
  });

  it("an install failure changes nothing at all", async () => {
    trace.failInstall = true;
    const files = snapshotFiles(trackedPaths());
    const error = await applyDeliverySwitch(dbState.servers[0], "local", { expectedFrom: "workshop", deps }).catch((e) => e);
    expect(error).toMatchObject({ code: "PANELBRIDGE_DELIVERY_INSTALL_FAILED", status: 500, restored: true });
    expect(trace.order).toEqual(["install"]);
    expect(snapshotFiles(trackedPaths())).toEqual(files);
  });

  it.each([
    ["the second ini write", () => { trace.failIniWriteAt = 2; }],
    ["recording the method", () => { dbState.failUpdate = true; }],
  ])("a failure at %s takes the just-installed file back out and restores the inis", async (_label, inject) => {
    const files = snapshotFiles(trackedPaths());
    const db = JSON.stringify(dbState.servers);
    inject();
    const error = await applyDeliverySwitch(dbState.servers[0], "local", { expectedFrom: "workshop", deps }).catch((e) => e);
    dbState.failUpdate = false;
    expect(error.restored).toBe(true);
    expect(snapshotFiles(trackedPaths())).toEqual(files);
    expect(fs.existsSync(looseServerPath(one.installDir))).toBe(false);
    expect(JSON.stringify(dbState.servers)).toBe(db);
  });

  it("a rollback puts back the exact bytes of a loose file that was already there", async () => {
    const stale = writeLoose(one.installDir, "media/lua/server/PanelBridge.lua", 'local VERSION = "0.0.1"\n');
    trace.failIniWriteAt = 1;
    await applyDeliverySwitch(dbState.servers[0], "local", { expectedFrom: "workshop", deps }).catch(() => {});
    expect(fs.readFileSync(stale, "utf8")).toBe('local VERSION = "0.0.1"\n');
  });
});

describe("refusals", () => {
  it("STALE when the method moved since the preview", async () => {
    seedGroup({ workshop: true });
    const error = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch((e) => e);
    expect(error).toMatchObject({ code: "PANELBRIDGE_DELIVERY_STALE", status: 409, params: { current: "workshop" } });
    expect(trace.order).toEqual([]);
  });

  it("UNAVAILABLE when the switch is blocked", async () => {
    seedGroup();
    dbState.servers[0].useNoSteam = true;
    const error = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch((e) => e);
    expect(error).toMatchObject({ code: "PANELBRIDGE_DELIVERY_UNAVAILABLE", status: 400, params: { reason: "noSteam" } });
    expect(trace.order).toEqual([]);
  });

  it("rejects a method that isn't local/workshop", async () => {
    seedGroup();
    await expect(applyDeliverySwitch(dbState.servers[0], "mod", { expectedFrom: "local", deps })).rejects.toMatchObject({
      code: "PANELBRIDGE_DELIVERY_METHOD_INVALID",
      status: 400,
    });
  });
});

describe("guided (remote)", () => {
  it("records the method on that profile only and touches no files", async () => {
    one = createServerFiles(root, { key: "s1" });
    dbState.servers = [makeServer(one, { id: "r1", name: "Remote", isRemote: true })];
    const before = snapshotFiles([one.iniPath]);
    const result = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps });
    expect(trace.order).toEqual(["persist"]);
    expect(result.access).toBe("guided");
    expect(dbState.servers[0]).toMatchObject({ bridgeDelivery: "workshop", bridgeDeliverySwitch: { workshopId: WS_ID } });
    expect(snapshotFiles([one.iniPath])).toEqual(before);
  });
});
