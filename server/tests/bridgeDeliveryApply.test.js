import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
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
const TRACE_DEFAULTS = vi.hoisted(() => ({
  iniWrites: 0,
  failIniWriteAt: null,
  corruptIniWriteAt: null,
  // Holds the first ini write until the test resolves it (lock tests).
  iniGate: null,
  failArchive: false,
  // What a failed archive reports about putting its own files back.
  failArchiveRestored: true,
  failInstall: false,
  // installBridge writes the file, then fails its read-back check.
  installWritesThenFails: false,
  // Records every writeFileAtomic() (the rollback's own writes) as write:<name>.
  traceWrites: false,
}));
const trace = vi.hoisted(() => ({ order: [] }));

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
      if (trace.iniGate && trace.iniWrites === 1) await trace.iniGate;
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
          error.restored = trace.failArchiveRestored;
          throw error;
        }
      }
      return actual.archiveLooseBridgeFiles(installDir, files, options);
    },
    restoreArchivedBridgeFiles: async (archived) => {
      trace.order.push("undo-archive");
      return actual.restoreArchivedBridgeFiles(archived);
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
      if (trace.installWritesThenFails) {
        actual.installBridge(server);
        return { success: false, error: "PanelBridge verification failed after install." };
      }
      return actual.installBridge(server);
    },
  };
});
vi.mock("../utils/fileWriteQueue.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileAtomic: (filePath, ...rest) => {
      if (trace.traceWrites) trace.order.push(`write:${path.basename(filePath)}`);
      return actual.writeFileAtomic(filePath, ...rest);
    },
  };
});

const { applyDeliverySwitch, reconcileBridge } = await import("../services/bridgeDelivery.js");
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
  Object.assign(trace, { order: [], ...TRACE_DEFAULTS });
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
    expect(result.status).toMatchObject({ method: "workshop", state: "workshop-restart-needed" });
  });

  // I5: DoLuaChecksum=true is never written automatically. Seeded off and
  // missing (a file that already says true couldn't show a wrong write).
  it.each([
    ["off", "DoLuaChecksum=false\r\n", "DoLuaChecksum=false\n"],
    ["missing", "", ""],
  ])("leaves a Lua integrity check that is %s exactly as it was (I5)", async (_label, seeded, expected) => {
    for (const iniPath of [one.iniPath, two.iniPath]) {
      fs.writeFileSync(iniPath, `PVP=true\r\nMods=OtherMod\r\nWorkshopItems=111\r\n${seeded}`);
    }
    await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps });
    for (const iniPath of [one.iniPath, two.iniPath]) {
      expect(readText(iniPath)).toBe(`PVP=true\nMods=OtherMod;${MOD}\nWorkshopItems=111;${WS_ID}\n${expected}`);
    }
  });

  it("is refused, touching nothing, when a sibling on the folder launches without Steam (I8)", async () => {
    dbState.servers[1].useNoSteam = true;
    const files = snapshotFiles(trackedPaths());
    const error = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch((e) => e);
    expect(error).toMatchObject({ code: "PANELBRIDGE_DELIVERY_UNAVAILABLE", params: { reason: "noSteam" } });
    expect(trace.order).toEqual([]);
    expect(snapshotFiles(trackedPaths())).toEqual(files);
    expect(dbState.servers.map((s) => s.bridgeDelivery)).toEqual([undefined, undefined]);
  });

  it("undoes in reverse order: the stored method, then the archived files, then the inis last-written first (I6)", async () => {
    dbState.failCommit = true;
    trace.traceWrites = true;
    await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch(() => {});
    expect(trace.order).toEqual([
      "ini",
      "write:servertest.ini",
      "ini",
      "write:second.ini",
      "archive",
      "persist",
      "persist",
      // commitNow() failed here; the rollback walks the steps backwards.
      "persist",
      "persist",
      "undo-archive",
      "write:PanelBridgeClient.lua",
      "write:PanelBridge.lua",
      "write:second.ini",
      "write:servertest.ini",
    ]);
  });

  it("reports restored:false when the archive couldn't put back the files it had already moved", async () => {
    trace.failArchive = true;
    trace.failArchiveRestored = false;
    const error = await applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps }).catch((e) => e);
    expect(error).toMatchObject({ code: "PANELBRIDGE_DELIVERY_FILE_ARCHIVE_FAILED", status: 500, restored: false });
  });

  it("a reconcile started during the apply waits for it, then follows the new method (I3)", async () => {
    let release;
    trace.iniGate = new Promise((resolve) => {
      release = resolve;
    });
    const applying = applyDeliverySwitch(dbState.servers[0], "workshop", { expectedFrom: "local", deps });
    await vi.waitFor(() => expect(trace.order).toContain("ini"));

    let reconciled = null;
    const reconciling = reconcileBridge(dbState.servers[0], { reason: "launch" }).then((result) => {
      reconciled = result;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Queued behind the apply on the same game folder, not racing it.
    expect(reconciled).toBeNull();

    release();
    await applying;
    const result = await reconciling;
    expect(result.method).toBe("workshop");
    expect(result.actions.map((action) => action.kind)).not.toContain("installed");
    expect(fs.existsSync(looseServerPath(one.installDir))).toBe(false);
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

  // installBridge() writes before it verifies, so it can fail AFTER the file
  // landed. The undo is registered before the install for exactly this.
  it.each([
    ["no loose file before", null],
    ["a stale loose file before", 'local VERSION = "0.0.1"\n'],
  ])("an install that writes and then fails its check is undone (%s)", async (_label, before) => {
    if (before !== null) writeLoose(one.installDir, "media/lua/server/PanelBridge.lua", before);
    trace.installWritesThenFails = true;
    const files = snapshotFiles(trackedPaths());
    const db = JSON.stringify(dbState.servers);
    const error = await applyDeliverySwitch(dbState.servers[0], "local", { expectedFrom: "workshop", deps }).catch((e) => e);
    expect(error).toMatchObject({ code: "PANELBRIDGE_DELIVERY_INSTALL_FAILED", status: 500, restored: true });
    expect(trace.order).toEqual(["install"]);
    expect(snapshotFiles(trackedPaths())).toEqual(files);
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
