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
  writeLoose,
} from "./helpers/bridgeDeliveryFixtures.js";

// reconcileBridge() is what boot, activation, setup, the Install button and
// the before-launch hook all run. It must follow the folder's effective
// method (I2/I3), leave DoLuaChecksum alone (I5), and never throw or hold a
// launch (I7).

const dbState = vi.hoisted(() => ({ servers: [], settings: {}, hang: false, throwOnRead: false }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  const impl = dbMockImplementation(dbState);
  return {
    ...impl,
    getServers: async () => {
      if (dbState.throwOnRead) throw new Error("db unavailable");
      if (dbState.hang) return new Promise(() => {});
      return impl.getServers();
    },
  };
});

const { reconcileBridge } = await import("../services/bridgeDelivery.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

let root;
let files;

function workshopServer(extra = {}, switchExtra = {}) {
  return makeServer(files, {
    bridgeDelivery: "workshop",
    bridgeDeliverySwitch: { to: "workshop", at: "2026-01-01T00:00:00.000Z", by: null, bridgeStartedAt: null, workshopId: WS_ID, ...switchExtra },
    ...extra,
  });
}

beforeEach(() => {
  root = createRoot();
  files = createServerFiles(root);
  Object.assign(dbState, { servers: [], settings: {}, hang: false, throwOnRead: false });
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("panel-installed (local)", () => {
  it("installs a missing bridge and updates a stale one", async () => {
    const server = makeServer(files);
    dbState.servers = [server];
    const first = await reconcileBridge(server, { reason: "launch" });
    expect(first).toMatchObject({ method: "local", skipped: null, warnings: [] });
    expect(first.actions).toEqual([{ kind: "installed", path: looseServerPath(files.installDir) }]);

    fs.writeFileSync(looseServerPath(files.installDir), 'local VERSION = "0.0.1"\n');
    const second = await reconcileBridge(server, { reason: "launch" });
    expect(second.actions).toEqual([{ kind: "updated", path: looseServerPath(files.installDir) }]);
    expect(fs.readFileSync(looseServerPath(files.installDir), "utf8")).toBe(bundledLua());
  });

  it.each(["boot", "activate", "launch"])("respects panelBridgeAutoUpdate=false for %s", async (reason) => {
    dbState.settings.panelBridgeAutoUpdate = false;
    const server = makeServer(files);
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason });
    expect(result.warnings).toEqual(["autoUpdateOff"]);
    expect(fs.existsSync(looseServerPath(files.installDir))).toBe(false);
  });

  it.each(["manual", "setup"])("ignores panelBridgeAutoUpdate=false for an explicit %s install", async (reason) => {
    dbState.settings.panelBridgeAutoUpdate = false;
    const server = makeServer(files);
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason });
    expect(result.actions.map((action) => action.kind)).toEqual(["installed"]);
  });

  it("archives the legacy client companion and root mod.info, and removes stale temp files", async () => {
    const client = writeLoose(files.installDir, "media/lua/client/PanelBridgeClient.lua", CLIENT_COMPANION);
    const rootInfo = writeLoose(files.installDir, "mod.info", "id=PanelBridge\n");
    const temp = writeLoose(files.installDir, `media/lua/server/.PanelBridge.lua.tmp.${process.pid}`, "partial");
    const server = makeServer(files);
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason: "boot" });
    expect(result.actions.map((action) => action.kind)).toEqual(["tempRemoved", "legacyArchived", "legacyArchived", "installed"]);
    for (const leftover of [client, rootInfo, temp]) expect(fs.existsSync(leftover)).toBe(false);
  });

  it("never writes into a folder a Workshop sibling shares (I3)", async () => {
    const siblingFiles = createServerFiles(root, { key: "s2", installDir: files.installDir });
    const local = makeServer(files, { id: "s1" });
    const sibling = makeServer(siblingFiles, { id: "s2", isActive: false, bridgeDelivery: "workshop" });
    dbState.servers = [local, sibling];
    const result = await reconcileBridge(local, { reason: "launch" });
    expect(result.method).toBe("workshop");
    expect(fs.existsSync(looseServerPath(files.installDir))).toBe(false);
  });

  it("re-reads the method from the database, not from the record it was handed", async () => {
    dbState.servers = [workshopServer()];
    const staleCopy = makeServer(files);
    const result = await reconcileBridge(staleCopy, { reason: "launch" });
    expect(result.method).toBe("workshop");
    expect(fs.existsSync(looseServerPath(files.installDir))).toBe(false);
  });

  it("a setup pseudo-record joins the folder's group", async () => {
    dbState.servers = [workshopServer()];
    const result = await reconcileBridge(
      { id: null, installPath: files.installDir, serverPath: files.installDir, isRemote: false },
      { reason: "setup" },
    );
    expect(result.method).toBe("workshop");
    expect(fs.existsSync(looseServerPath(files.installDir))).toBe(false);
  });
});

describe("Steam Workshop", () => {
  it("archives every loose file, case variants and unrecognized ones included", async () => {
    const variant = writeLoose(files.installDir, "media/lua/server/panelbridge.lua", "-- someone else's\n");
    const server = workshopServer();
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason: "launch" });
    expect(result.actions).toEqual(
      expect.arrayContaining([{ kind: "archived", path: variant }, { kind: "iniEntriesAdded", path: files.iniPath }]),
    );
    expect(fs.existsSync(variant)).toBe(false);
  });

  it("re-adds only this server's own entries and never touches DoLuaChecksum", async () => {
    const siblingFiles = createServerFiles(root, { key: "s2", serverName: "second", installDir: files.installDir });
    const server = workshopServer({ id: "s1" });
    const sibling = makeServer(siblingFiles, { id: "s2", serverName: "second", isActive: false });
    dbState.servers = [server, sibling];
    const siblingBefore = fs.readFileSync(siblingFiles.iniPath);

    await reconcileBridge(server, { reason: "launch" });

    expect(readText(files.iniPath)).toBe(`PVP=true\nMods=OtherMod;${MOD}\nWorkshopItems=111;${WS_ID}\nDoLuaChecksum=true\n`);
    expect(fs.readFileSync(files.iniPath, "utf8")).toContain("\r\n");
    expect(fs.readFileSync(siblingFiles.iniPath)).toEqual(siblingBefore);
  });

  it("leaves an ini that already lists both entries untouched", async () => {
    fs.writeFileSync(files.iniPath, `Mods=\\${MOD}\r\nWorkshopItems=${WS_ID}\r\n`);
    const before = fs.statSync(files.iniPath).mtimeMs;
    const server = workshopServer();
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason: "launch" });
    expect(result.actions).toEqual([]);
    expect(fs.statSync(files.iniPath).mtimeMs).toBe(before);
  });

  it("migrates the recorded item id to this release's id", async () => {
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\r\nWorkshopItems=111;999\r\n`);
    const server = workshopServer({}, { workshopId: "999" });
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason: "launch" });
    expect(result.actions.map((action) => action.kind)).toEqual(["iniEntriesAdded", "iniEntryMigrated"]);
    expect(readText(files.iniPath)).toBe(`Mods=${MOD}\nWorkshopItems=111;${WS_ID}\n`);
  });

  // §6.7: the game applies the LAST line of a duplicated key, while the
  // entries would go onto the first -- a "successful" write the game ignores.
  it("leaves an ini with a duplicated Mods=/WorkshopItems= key alone and warns", async () => {
    fs.writeFileSync(files.iniPath, `Mods=OtherMod\r\nWorkshopItems=111\r\nWorkshopItems=111\r\n`);
    const before = fs.readFileSync(files.iniPath);
    const server = workshopServer();
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason: "launch" });
    expect(result.warnings).toEqual(["iniWriteFailed"]);
    expect(result.actions.map((action) => action.kind)).not.toContain("iniEntriesAdded");
    expect(fs.readFileSync(files.iniPath)).toEqual(before);
  });

  it("warns and leaves the ini alone when the server launches without Steam", async () => {
    const before = fs.readFileSync(files.iniPath);
    const server = workshopServer({ useNoSteam: true });
    dbState.servers = [server];
    const result = await reconcileBridge(server, { reason: "launch" });
    expect(result.warnings).toEqual(["noSteam"]);
    expect(fs.readFileSync(files.iniPath)).toEqual(before);
  });

  it("warns when no item id is known, or the ini doesn't exist yet", async () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "");
    _resetWorkshopReleaseCacheForTests();
    const noId = workshopServer({}, { workshopId: null });
    dbState.servers = [noId];
    expect((await reconcileBridge(noId, { reason: "launch" })).warnings).toEqual(["workshopIdUnknown"]);

    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
    _resetWorkshopReleaseCacheForTests();
    fs.rmSync(files.iniPath);
    const server = workshopServer();
    dbState.servers = [server];
    expect((await reconcileBridge(server, { reason: "launch" })).warnings).toEqual(["iniMissing"]);
  });
});

describe("never throws, never blocks (I7)", () => {
  it("skips a missing server, a remote one, and a folder that doesn't exist", async () => {
    expect(await reconcileBridge(null, { reason: "launch" })).toMatchObject({ skipped: "noServer" });
    expect(await reconcileBridge(makeServer(files, { isRemote: true }), { reason: "launch" })).toMatchObject({ skipped: "remote" });
    expect(
      await reconcileBridge(makeServer(files, { installPath: path.join(root, "missing") }), { reason: "launch" }),
    ).toMatchObject({ skipped: "noInstallDir" });
  });

  it("turns an internal error into a warning instead of throwing", async () => {
    dbState.throwOnRead = true;
    await expect(reconcileBridge(makeServer(files), { reason: "launch" })).resolves.toEqual({
      method: null,
      skipped: null,
      actions: [],
      warnings: ["installFailed"],
    });
  });

  it("gives up waiting after the timeout", async () => {
    dbState.hang = true;
    const started = Date.now();
    const result = await reconcileBridge(makeServer(files, { installPath: files.installDir }), { reason: "launch", timeoutMs: 50 });
    expect(result).toMatchObject({ skipped: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
