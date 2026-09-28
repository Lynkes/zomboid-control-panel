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
  writeLoose,
} from "./helpers/bridgeDeliveryFixtures.js";

// The preview IS the contract with the operator: the dialog lists these
// steps, in this order, with these exact values and paths, and apply runs the
// same plan. A dry run must never touch the disk.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  return dbMockImplementation(dbState);
});
vi.mock("../utils/serverStatus.js", () => ({ resolveObservedServerRunning: vi.fn(async () => false) }));

const { planDeliverySwitch } = await import("../services/bridgeDelivery.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

let root;
let files;
const deps = { serverManager: { startTime: null }, bridge: { getStatus: () => ({ modStatus: null }) } };

function workshopRecord(extra = {}) {
  return {
    bridgeDelivery: "workshop",
    bridgeDeliverySwitch: { to: "workshop", at: new Date().toISOString(), by: null, bridgeStartedAt: null, workshopId: WS_ID },
    ...extra,
  };
}

function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[full] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = createRoot();
  files = createServerFiles(root);
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("to Workshop, automatic", () => {
  it("adds both entries, archives every loose file (legacy included), then records the method", async () => {
    const server = makeServer(files);
    dbState.servers = [server];
    const serverLua = writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    const client = writeLoose(files.installDir, "media/lua/client/PanelBridgeClient.lua", CLIENT_COMPANION);
    const rootInfo = writeLoose(files.installDir, "mod.info", "name=PanelBridge\nid=PanelBridge\n");

    const plan = await planDeliverySwitch(server, "workshop", deps);

    expect(plan).toMatchObject({ from: "local", to: "workshop", access: "automatic", blocked: null, applied: false, restartRequired: true, backups: [], manual: null });
    expect(plan.steps).toEqual([
      { kind: "iniAdd", key: "Mods", value: MOD, file: files.iniPath, serverName: "Server One" },
      { kind: "iniAdd", key: "WorkshopItems", value: WS_ID, file: files.iniPath, serverName: "Server One" },
      { kind: "archiveFile", file: serverLua, fileKind: "server", recognized: true },
      { kind: "archiveFile", file: client, fileKind: "client", recognized: true },
      { kind: "archiveFile", file: rootInfo, fileKind: "rootModInfo", recognized: true },
      { kind: "recordMethod", method: "workshop", servers: ["Server One"] },
    ]);
    expect(plan.status.state).toBe("local-ok");
  });

  it("skips entries already present and warns about a loose file the panel didn't write", async () => {
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\r\nWorkshopItems=\r\n`);
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", "-- not ours\n");
    const server = makeServer(files);
    dbState.servers = [server];
    const plan = await planDeliverySwitch(server, "workshop", deps);
    expect(plan.steps.map((step) => `${step.kind}:${step.key || step.fileKind || step.method}`)).toEqual([
      "iniAdd:WorkshopItems",
      "archiveFile:server",
      "recordMethod:workshop",
    ]);
    expect(plan.steps[1].recognized).toBe(false);
    expect(plan.warnings).toContain("unrecognizedLooseFile");
  });

  it("is blocked, with the steps still listed, when the switch isn't available", async () => {
    const server = makeServer(files, { useNoSteam: true });
    dbState.servers = [server];
    const plan = await planDeliverySwitch(server, "workshop", deps);
    expect(plan.blocked).toEqual({ reason: "noSteam" });
  });

  it("never lists a WorkshopItems step without a value when no item id is known", async () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "");
    _resetWorkshopReleaseCacheForTests();
    const server = makeServer(files);
    dbState.servers = [server];
    const plan = await planDeliverySwitch(server, "workshop", deps);
    expect(plan.blocked).toEqual({ reason: "notPublished" });
    expect(plan.steps.filter((step) => step.kind === "iniAdd")).toEqual([
      { kind: "iniAdd", key: "Mods", value: MOD, file: files.iniPath, serverName: "Server One" },
    ]);
  });
});

describe("to Local, automatic", () => {
  it("installs first, then removes the entries and turns the checksum off per ini, then records", async () => {
    fs.writeFileSync(files.iniPath, `Mods=A;${MOD}\r\nWorkshopItems=1;${WS_ID};999\r\nDoLuaChecksum=true\r\n`);
    const server = makeServer(files, workshopRecord({ bridgeDeliverySwitch: { to: "workshop", at: "2026-01-01T00:00:00Z", workshopId: "999" } }));
    dbState.servers = [server];

    const plan = await planDeliverySwitch(server, "local", deps);

    expect(plan).toMatchObject({ from: "workshop", to: "local", blocked: null });
    expect(plan.steps).toEqual([
      { kind: "installFile", file: looseServerPath(files.installDir), version: expect.any(String) },
      { kind: "iniRemove", key: "Mods", value: MOD, file: files.iniPath, serverName: "Server One" },
      { kind: "iniRemove", key: "WorkshopItems", value: WS_ID, file: files.iniPath, serverName: "Server One" },
      { kind: "iniRemove", key: "WorkshopItems", value: "999", file: files.iniPath, serverName: "Server One" },
      { kind: "iniSet", key: "DoLuaChecksum", value: "false", before: "true", file: files.iniPath, serverName: "Server One" },
      { kind: "recordMethod", method: "local", servers: ["Server One"] },
    ]);
    expect(plan.warnings).toContain("checksumWillBeTurnedOff");
  });

  it("emits the checksum step when the key is missing, and not when it is already false", async () => {
    const server = makeServer(files, workshopRecord());
    dbState.servers = [server];
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\nWorkshopItems=${WS_ID}\n`);
    const missing = await planDeliverySwitch(server, "local", deps);
    expect(missing.steps.find((step) => step.kind === "iniSet")).toMatchObject({ before: null });

    fs.writeFileSync(files.iniPath, `Mods=${MOD}\nWorkshopItems=${WS_ID}\nDoLuaChecksum=False\n`);
    const alreadyOff = await planDeliverySwitch(server, "local", deps);
    expect(alreadyOff.steps.some((step) => step.kind === "iniSet")).toBe(false);
    expect(alreadyOff.warnings).not.toContain("checksumWillBeTurnedOff");
  });

  it("is blocked as sameMethod for a Local server with nothing to clean up", async () => {
    const server = makeServer(files);
    dbState.servers = [server];
    expect((await planDeliverySwitch(server, "local", deps)).blocked).toEqual({ reason: "sameMethod" });
  });

  // "Switch, restart later" back to panel-installed: the entries are already
  // gone, and the Workshop heartbeat is the run from before the switch. The
  // same switch again would only rewrite the record.
  it("is blocked as sameMethod right after a switch back, while the pre-switch run still reports the Workshop copy", async () => {
    fs.writeFileSync(files.iniPath, "Mods=OtherMod\r\nWorkshopItems=111\r\nDoLuaChecksum=false\r\n");
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    const server = makeServer(files, {
      bridgeDeliverySwitch: {
        to: "local",
        at: new Date(Date.now() - 30 * 1000).toISOString(),
        by: "admin",
        bridgeStartedAt: 2000,
        workshopId: null,
      },
    });
    dbState.servers = [server];
    const modStatus = { alive: true, startedAt: 2000, delivery: { method: "workshop", workshopId: WS_ID } };
    const plan = await planDeliverySwitch(server, "local", { ...deps, bridge: { getStatus: () => ({ modStatus }) } });
    expect(plan).toMatchObject({ from: "local", to: "local", blocked: { reason: "sameMethod" } });
    expect(plan.status.state).toBe("local-ok");
  });

  it("stays available to a Local server whose ini still lists the bridge (a crashed switch)", async () => {
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\nWorkshopItems=${WS_ID}\nDoLuaChecksum=false\n`);
    const server = makeServer(files);
    dbState.servers = [server];
    const plan = await planDeliverySwitch(server, "local", deps);
    expect(plan).toMatchObject({ from: "local", blocked: null, restartRequired: true });
    expect(plan.steps.map((step) => step.kind)).toEqual(["installFile", "iniRemove", "iniRemove", "recordMethod"]);
  });

  // The removal takes the entries out of EVERY Mods=/WorkshopItems= line
  // (the game applies the last one), `\`-prefixed item ids included, so the
  // preview and the clean-up offer look at every line the same way.
  it("lists what the removal takes from a duplicated key's later line, and offers the clean-up for it", async () => {
    fs.writeFileSync(files.iniPath, `Mods=A\nMods=${MOD}\nWorkshopItems=1\nWorkshopItems=\\${WS_ID}\nDoLuaChecksum=false\n`);
    const server = makeServer(files);
    dbState.servers = [server];
    const plan = await planDeliverySwitch(server, "local", deps);
    expect(plan.blocked).toBeNull();
    expect(plan.steps.filter((step) => step.kind === "iniRemove").map((step) => `${step.key}=${step.value}`)).toEqual([
      `Mods=${MOD}`,
      `WorkshopItems=${WS_ID}`,
    ]);
  });
});

describe("guided (remote) plans", () => {
  it("records the method only and hands back the manual values", async () => {
    const server = makeServer(files, { isRemote: true });
    dbState.servers = [server];
    const toWorkshop = await planDeliverySwitch(server, "workshop", deps);
    expect(toWorkshop.access).toBe("guided");
    expect(toWorkshop.steps).toEqual([{ kind: "recordMethod", method: "workshop", servers: ["Server One"] }]);
    expect(toWorkshop.manual).toEqual({
      modsEntry: MOD,
      workshopItemsEntry: WS_ID,
      removeFiles: ["media/lua/server/PanelBridge.lua", "media/lua/client/PanelBridgeClient.lua"],
      setChecksumFalse: false,
    });

    dbState.servers = [{ ...server, ...workshopRecord() }];
    const toLocal = await planDeliverySwitch(dbState.servers[0], "local", deps);
    expect(toLocal.manual).toMatchObject({ removeFiles: [], setChecksumFalse: true });
  });
});

describe("install groups", () => {
  it("edits every sibling's ini and records the method on every profile of the folder", async () => {
    const other = createServerFiles(root, { key: "s2", serverName: "second", installDir: files.installDir });
    const one = makeServer(files, { id: "s1", name: "One" });
    const two = makeServer(other, { id: "s2", name: "Two", serverName: "second", isActive: false });
    dbState.servers = [one, two];
    const plan = await planDeliverySwitch(one, "workshop", deps);
    expect(plan.sharedWith).toEqual([{ id: "s2", name: "Two" }]);
    expect(plan.steps.filter((step) => step.kind === "iniAdd").map((step) => step.file)).toEqual([
      files.iniPath,
      files.iniPath,
      other.iniPath,
      other.iniPath,
    ]);
    expect(plan.steps.at(-1)).toEqual({ kind: "recordMethod", method: "workshop", servers: ["One", "Two"] });
    expect(plan.warnings).toContain("sharedInstall");
  });

  it("Workshop wins for the whole folder, matched case-insensitively on Windows", async () => {
    const two = createServerFiles(root, { key: "s2", installDir: files.installDir });
    const variant = process.platform === "win32" ? `${files.installDir.toUpperCase()}\\` : files.installDir;
    const one = makeServer(files, { id: "s1", name: "One" });
    const workshopSibling = makeServer(two, { id: "s2", name: "Two", installPath: variant, isActive: false, ...workshopRecord() });
    dbState.servers = [one, workshopSibling];
    const plan = await planDeliverySwitch(one, "workshop", deps);
    expect(plan.from).toBe("workshop");
    expect(plan.blocked).toEqual({ reason: "sameMethod" });
  });

  // The switch writes the entries into every sibling's ini and archives the
  // shared loose file, so a sibling that launches without Steam would start
  // with no bridge and refuse every join (ModRequired): it blocks the switch
  // exactly as this profile would.
  it.each([
    ["the Launch without Steam flag", { useNoSteam: true }],
    ["a -nosteam start command", { startCommand: "StartServer64.bat -nosteam" }],
  ])("is blocked as noSteam when a sibling on the folder has %s", async (_label, siblingLaunch) => {
    const other = createServerFiles(root, { key: "s2", serverName: "second", installDir: files.installDir });
    const one = makeServer(files, { id: "s1", name: "One" });
    const two = makeServer(other, { id: "s2", name: "Two", serverName: "second", isActive: false, ...siblingLaunch });
    dbState.servers = [one, two];
    const plan = await planDeliverySwitch(one, "workshop", deps);
    expect(plan.blocked).toEqual({ reason: "noSteam" });
    expect(plan.status.switchAvailability.toWorkshop).toMatchObject({ available: false, reason: "noSteam" });
  });

  it("a -nosteam profile on ANOTHER folder doesn't block the switch", async () => {
    const other = createServerFiles(root, { key: "s2", serverName: "second" });
    const one = makeServer(files, { id: "s1", name: "One" });
    const two = makeServer(other, { id: "s2", name: "Two", serverName: "second", isActive: false, useNoSteam: true });
    dbState.servers = [one, two];
    expect((await planDeliverySwitch(one, "workshop", deps)).blocked).toBeNull();
  });

  it("warns when a sibling has no ini yet", async () => {
    const other = createServerFiles(root, { key: "s2", installDir: files.installDir, ini: null });
    const one = makeServer(files, { id: "s1", name: "One" });
    const two = makeServer(other, { id: "s2", name: "Two", isActive: false });
    dbState.servers = [one, two];
    const plan = await planDeliverySwitch(one, "workshop", deps);
    expect(plan.warnings).toContain("siblingIniMissing");
    expect(plan.blocked).toBeNull();
  });
});

describe("dry run", () => {
  it("never writes, moves or deletes anything", async () => {
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\r\nWorkshopItems=${WS_ID}\r\nDoLuaChecksum=true\r\n`);
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    writeLoose(files.installDir, "media/lua/client/PanelBridgeClient.lua", CLIENT_COMPANION);
    const server = makeServer(files, workshopRecord());
    dbState.servers = [server];
    const before = snapshotTree(root);
    const spies = ["writeFileSync", "renameSync", "unlinkSync", "copyFileSync", "rmSync", "writeSync"].map((name) =>
      vi.spyOn(fs, name),
    );

    await planDeliverySwitch(server, "local", deps);
    dbState.servers = [makeServer(files)];
    await planDeliverySwitch(dbState.servers[0], "workshop", deps);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(snapshotTree(root)).toEqual(before);
  });
});
