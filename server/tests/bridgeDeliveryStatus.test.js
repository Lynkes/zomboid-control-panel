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

// GET /api/panel-bridge/delivery's whole answer is computed server-side
// (the client only maps `state` to copy), so every DeliveryState, the
// Workshop availability order, the checksum offer and hostOs are pinned here
// against real temp folders.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));
const runningState = vi.hoisted(() => ({ value: null }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  return dbMockImplementation(dbState);
});
vi.mock("../utils/serverStatus.js", () => ({
  resolveObservedServerRunning: vi.fn(async () => runningState.value),
}));

const { getDeliveryStatus } = await import("../services/bridgeDelivery.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

let root;
let files;

function deps({ modStatus = null, startTime = null, modChecker = {} } = {}) {
  return {
    serverManager: { startTime },
    rconService: { connected: false },
    modChecker,
    bridge: { getStatus: () => ({ modStatus }) },
  };
}

function useRelease(id) {
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", id || "");
  _resetWorkshopReleaseCacheForTests();
}

function switchedToWorkshop(overrides = {}, record = {}) {
  return makeServer(files, {
    bridgeDelivery: "workshop",
    bridgeDeliverySwitch: {
      to: "workshop",
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      by: "admin",
      bridgeStartedAt: 1000,
      workshopId: WS_ID,
      ...record,
    },
    ...overrides,
  });
}

async function statusFor(server, depOptions) {
  dbState.servers = [server];
  return getDeliveryStatus(server, deps(depOptions));
}

beforeEach(() => {
  root = createRoot();
  files = createServerFiles(root);
  dbState.servers = [];
  dbState.settings = {};
  runningState.value = null;
  useRelease(WS_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("states: panel-installed (local)", () => {
  it("local-not-installed when the game folder has no PanelBridge.lua", async () => {
    expect((await statusFor(makeServer(files))).state).toBe("local-not-installed");
  });

  it("local-update-pending when the loose file differs from the bundled one", async () => {
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", 'local VERSION = "0.0.1"\n');
    expect((await statusFor(makeServer(files))).state).toBe("local-update-pending");
  });

  it("local-ok when the loose file matches the bundled one", async () => {
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    const status = await statusFor(makeServer(files));
    expect(status).toMatchObject({ state: "local-ok", method: "local", ownMethod: "local", access: "automatic" });
  });

  it("local-workshop-loaded when the heartbeat says the Workshop copy is running", async () => {
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    const status = await statusFor(makeServer(files), {
      modStatus: { alive: true, version: "1.7.71", delivery: { method: "workshop", workshopId: WS_ID } },
    });
    expect(status.state).toBe("local-workshop-loaded");
    // Switching "back" to Local stays possible here: it is how the leftover
    // entries get removed.
    expect(status.switchAvailability.toLocal.available).toBe(true);
  });

  // "Switch, restart later" back to panel-installed on a running Workshop
  // server: the entries are gone and the loose file is in place, but the
  // game keeps the copy it loaded until it restarts, and its heartbeat still
  // says so. That is the switch not having taken effect yet -- not a
  // settings file that still asks for the Workshop copy -- so no second
  // "Switch to panel-installed" that could only rewrite the record.
  describe("after a switch back to panel-installed", () => {
    const localRecord = (extra = {}) =>
      makeServer(files, {
        bridgeDeliverySwitch: {
          to: "local",
          at: new Date(Date.now() - 30 * 1000).toISOString(),
          by: "admin",
          bridgeStartedAt: 2000,
          workshopId: null,
          ...extra,
        },
      });
    const workshopRun = (startedAt) => ({
      alive: true,
      version: "1.7.71",
      startedAt,
      delivery: { method: "workshop", workshopId: WS_ID },
    });

    beforeEach(() => {
      fs.writeFileSync(files.iniPath, "Mods=OtherMod\r\nWorkshopItems=111\r\nDoLuaChecksum=false\r\n");
      writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
      runningState.value = true;
    });

    it("the run from before the switch reads from the folder, with no clean-up to offer", async () => {
      const status = await statusFor(localRecord(), { modStatus: workshopRun(2000) });
      expect(status).toMatchObject({ state: "local-ok", restartedSinceSwitch: false });
      expect(status.switchAvailability.toLocal).toMatchObject({ available: false, reason: "sameMethod" });
    });

    it("stays so after the panel restarts the game, until the new run reports in", async () => {
      const status = await statusFor(localRecord(), { modStatus: workshopRun(2000), startTime: new Date() });
      expect(status).toMatchObject({ state: "local-ok", restartedSinceSwitch: true });
    });

    it("a run started after the switch that loads the Workshop copy is local-workshop-loaded", async () => {
      const status = await statusFor(localRecord(), { modStatus: workshopRun(3000) });
      expect(status).toMatchObject({ state: "local-workshop-loaded", restartedSinceSwitch: true });
      expect(status.switchAvailability.toLocal.available).toBe(true);
    });
  });

  it("guided: local-unverified with no heartbeat, local-ok with a live one", async () => {
    const remote = makeServer(files, { isRemote: true });
    expect((await statusFor(remote)).state).toBe("local-unverified");
    const live = await statusFor(remote, { modStatus: { alive: true, version: "1.7.70" } });
    expect(live).toMatchObject({ state: "local-ok", access: "guided", disk: null, hostOs: "unknown" });
    expect(live.checksum.current).toBeNull();
  });
});

describe("states: Steam Workshop", () => {
  it("workshop-id-unknown when this build has no id and none was recorded", async () => {
    useRelease(null);
    const status = await statusFor(switchedToWorkshop({}, { workshopId: null }));
    expect(status).toMatchObject({ state: "workshop-id-unknown", effectiveWorkshopId: null });
  });

  it("keeps using the recorded id when this build knows none", async () => {
    useRelease(null);
    expect((await statusFor(switchedToWorkshop())).effectiveWorkshopId).toBe(WS_ID);
  });

  it("workshop-restart-needed until the game has started since the switch", async () => {
    runningState.value = true;
    const status = await statusFor(switchedToWorkshop(), {
      modStatus: { alive: true, startedAt: 1000, delivery: { method: "loose" } },
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    expect(status).toMatchObject({ state: "workshop-restart-needed", restartedSinceSwitch: false });
  });

  it("detects a restart clock-free: the bridge's own startedAt changed", async () => {
    const status = await statusFor(switchedToWorkshop(), {
      modStatus: { alive: true, startedAt: 2000, delivery: { method: "workshop", workshopId: WS_ID } },
    });
    expect(status).toMatchObject({ state: "workshop-confirmed", restartedSinceSwitch: true });
    expect(status.live).toMatchObject({ delivery: "workshop", workshopId: WS_ID, startedAt: 2000 });
  });

  // A sibling on the same game folder (or a server whose bridge wasn't
  // reporting at switch time) has no bridge baseline in its record. The run
  // that was already going before the switch must not count as a restart.
  it("no baseline: a bridge that started before the switch is not a restart (workshop-restart-needed)", async () => {
    runningState.value = true;
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const status = await statusFor(switchedToWorkshop({}, { bridgeStartedAt: null }), {
      modStatus: { alive: true, startedAt: twoHoursAgo, delivery: { method: "loose" } },
      startTime: new Date(twoHoursAgo),
    });
    expect(status).toMatchObject({ state: "workshop-restart-needed", restartedSinceSwitch: false });
  });

  it("no baseline: a bridge that started after the switch is a restart (same host, same clock)", async () => {
    const status = await statusFor(switchedToWorkshop({}, { bridgeStartedAt: null }), {
      modStatus: { alive: true, startedAt: Date.now() - 60 * 1000, delivery: { method: "workshop", workshopId: WS_ID } },
    });
    expect(status).toMatchObject({ state: "workshop-confirmed", restartedSinceSwitch: true });
  });

  it("no baseline on a remote profile: any bridge startedAt counts, its clock isn't the panel's", async () => {
    const status = await statusFor(switchedToWorkshop({ isRemote: true }, { bridgeStartedAt: null }), {
      modStatus: { alive: true, startedAt: 5, delivery: { method: "workshop", workshopId: WS_ID } },
    });
    expect(status).toMatchObject({ state: "workshop-confirmed", restartedSinceSwitch: true });
  });

  it("detects a restart from the panel's own start time after the switch", async () => {
    runningState.value = true;
    const status = await statusFor(switchedToWorkshop(), { startTime: new Date() });
    expect(status).toMatchObject({ restartedSinceSwitch: true, state: "workshop-waiting" });
  });

  // "Switch and restart now" with nobody online: the old run's status.json
  // reads as alive for up to 5 minutes after it stopped (statusStaleIdleMs),
  // and it is the run the switch recorded. It says nothing about the boot
  // under way, which is still downloading the item.
  it("workshop-waiting, not workshop-not-loaded, while the heartbeat is the run from before the switch", async () => {
    runningState.value = true;
    const status = await statusFor(
      switchedToWorkshop({}, { at: new Date(Date.now() - 60 * 1000).toISOString(), bridgeStartedAt: 1000 }),
      {
        modStatus: { alive: true, startedAt: 1000, playerCount: 0, delivery: { method: "loose" } },
        startTime: new Date(Date.now() - 10 * 1000),
      },
    );
    expect(status).toMatchObject({ state: "workshop-waiting", restartedSinceSwitch: true });
    expect(status.live).toMatchObject({ alive: true, delivery: "loose", startedAt: 1000 });
  });

  // A sibling (no bridge baseline in its record): the clock decides, and a
  // run that started before the panel's latest start is the previous one.
  it("no baseline: a heartbeat from before the panel's latest start is the previous run's", async () => {
    runningState.value = true;
    const status = await statusFor(switchedToWorkshop({}, { bridgeStartedAt: null }), {
      modStatus: { alive: true, startedAt: Date.now() - 20 * 60 * 1000, delivery: { method: "loose" } },
      startTime: new Date(Date.now() - 10 * 1000),
    });
    expect(status.state).toBe("workshop-waiting");

    const reported = await statusFor(switchedToWorkshop({}, { bridgeStartedAt: null }), {
      modStatus: { alive: true, startedAt: Date.now() - 2 * 1000, delivery: { method: "workshop", workshopId: WS_ID } },
      startTime: new Date(Date.now() - 10 * 1000),
    });
    expect(reported.state).toBe("workshop-confirmed");
  });

  it("workshop-waiting turns into workshop-not-loaded after the 5-minute grace", async () => {
    runningState.value = true;
    const status = await statusFor(switchedToWorkshop({}, { at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }), {
      startTime: new Date(Date.now() - 10 * 60 * 1000),
    });
    expect(status.state).toBe("workshop-not-loaded");
  });

  it("workshop-not-loaded when the bridge reports a loose copy or a different id", async () => {
    const loose = await statusFor(switchedToWorkshop(), {
      modStatus: { alive: true, startedAt: 2000, delivery: { method: "loose" } },
    });
    expect(loose.state).toBe("workshop-not-loaded");
    const otherId = await statusFor(switchedToWorkshop(), {
      modStatus: { alive: true, startedAt: 2000, delivery: { method: "workshop", workshopId: "1" } },
    });
    expect(otherId.state).toBe("workshop-not-loaded");
  });

  it("an old bridge with no delivery field reads as loose", async () => {
    const status = await statusFor(switchedToWorkshop(), { modStatus: { alive: true, startedAt: 2000 } });
    expect(status.live.delivery).toBe("loose");
    expect(status.state).toBe("workshop-not-loaded");
  });

  it("workshop-stopped when the server is down with no failure in its log", async () => {
    runningState.value = false;
    const status = await statusFor(switchedToWorkshop(), {
      modStatus: { alive: false, startedAt: 2000, delivery: { method: "workshop", workshopId: WS_ID } },
    });
    expect(status.state).toBe("workshop-stopped");
  });

  it("workshop-start-failed when the latest log shows the bridge item failing", async () => {
    runningState.value = false;
    fs.writeFileSync(
      path.join(files.dataDir, "server-console.txt"),
      `Workshop: onItemNotDownloaded itemID=${WS_ID} result=9\r\n`,
    );
    const status = await statusFor(switchedToWorkshop());
    expect(status.state).toBe("workshop-start-failed");
    expect(status.lastStartFailure).toMatchObject({ kind: "itemDownload", result: 9 });
  });

  // No item is named: 42.20 checks the Steam connection for every server in
  // Steam mode, before any download. The client words and acts on it by kind.
  it("workshop-start-failed with kind steamUnreachable when the latest log shows Steam unreachable", async () => {
    runningState.value = false;
    fs.writeFileSync(
      path.join(files.dataDir, "server-console.txt"),
      "LOG  : General , 1> Waiting for response from Steam servers\r\nLOG  : General , 2> Failed to connect to Steam servers\r\n",
    );
    const status = await statusFor(switchedToWorkshop());
    expect(status.state).toBe("workshop-start-failed");
    expect(status.lastStartFailure).toMatchObject({
      kind: "steamUnreachable",
      result: null,
      line: "LOG  : General , 2> Failed to connect to Steam servers",
    });
    expect(status.switchAvailability.toLocal.available).toBe(true);
  });

  it("steamReportsUnavailable and modAutoRestart come from modChecker", async () => {
    const status = await statusFor(switchedToWorkshop(), {
      modChecker: { lastUnavailableWorkshopIds: new Map([[WS_ID, "removed"]]), autoRestartEnabled: true },
    });
    expect(status).toMatchObject({ steamReportsUnavailable: true, modAutoRestart: true });
  });

  it("reports the disk: leftovers, ini entries and the downloaded item", async () => {
    writeLoose(files.installDir, "media/lua/client/PanelBridgeClient.lua", CLIENT_COMPANION);
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\r\nWorkshopItems=${WS_ID}\r\n`);
    const item = path.join(files.installDir, "steamapps", "workshop", "content", "108600", WS_ID, "mods", MOD, "42");
    fs.mkdirSync(item, { recursive: true });
    fs.writeFileSync(path.join(item, "mod.info"), `id=${MOD}\nmodversion=1.7.71\n`);
    const { disk } = await statusFor(switchedToWorkshop());
    expect(disk.iniEntries).toEqual({ mods: true, workshopItems: true });
    expect(disk.looseFiles).toEqual([expect.objectContaining({ kind: "client", recognized: true })]);
    expect(disk.workshopItem).toMatchObject({ version: "1.7.71", source: "candidate" });
  });

  it("reports the ini entries the game reads: the last line of a duplicated key", async () => {
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\r\nWorkshopItems=111;${WS_ID}\r\nWorkshopItems=111\r\n`);
    const { disk } = await statusFor(switchedToWorkshop());
    expect(disk.iniEntries).toEqual({ mods: true, workshopItems: false });
  });

  it.each([
    ["a `Key =` line (an option the game doesn't have)", `Mods =${MOD}\r\nWorkshopItems=${WS_ID}\r\n`, { mods: false, workshopItems: true }],
    ["a `\\`-prefixed item id (not a Steam id to the game)", `Mods=\\${MOD}\r\nWorkshopItems=\\${WS_ID}\r\n`, { mods: true, workshopItems: false }],
  ])("reports %s as missing", async (_label, ini, expected) => {
    fs.writeFileSync(files.iniPath, ini);
    const { disk } = await statusFor(switchedToWorkshop());
    expect(disk.iniEntries).toEqual(expected);
  });
});

describe("install groups", () => {
  it("a Local profile sharing a game folder with a Workshop profile is Workshop, and names its siblings", async () => {
    const other = createServerFiles(root, { key: "s2", installDir: files.installDir });
    const local = makeServer(files, { id: "s1", name: "Local One" });
    const workshop = makeServer(other, { id: "s2", name: "Workshop Two", isActive: false, bridgeDelivery: "workshop" });
    dbState.servers = [local, workshop];
    const status = await getDeliveryStatus(local, deps());
    expect(status).toMatchObject({ method: "workshop", ownMethod: "local", sharedWith: [{ id: "s2", name: "Workshop Two" }] });
  });

  // With no published release id, a profile that joined the folder later
  // (no switch record of its own) uses the id its Workshop sibling switched
  // with: the one already in the inis, and the one to look for on disk.
  it("takes the item id from a sibling's switch record when no release id is published", async () => {
    useRelease(null);
    const other = createServerFiles(root, { key: "s2", installDir: files.installDir });
    const local = makeServer(files, { id: "s1", name: "Joined Later" });
    const workshop = makeServer(other, {
      id: "s2",
      name: "Switched",
      isActive: false,
      bridgeDelivery: "workshop",
      bridgeDeliverySwitch: { to: "workshop", at: "2026-01-01T00:00:00.000Z", by: "admin", bridgeStartedAt: null, workshopId: "999" },
    });
    dbState.servers = [local, workshop];
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\r\nWorkshopItems=999\r\n`);
    const status = await getDeliveryStatus(local, deps());
    expect(status).toMatchObject({ method: "workshop", effectiveWorkshopId: "999", release: { status: "not-published" } });
    expect(status.disk.iniEntries).toEqual({ mods: true, workshopItems: true });
  });
});

describe("switchAvailability.toWorkshop order (first match wins)", () => {
  it("notPublished beats everything else", async () => {
    useRelease(null);
    const status = await statusFor(makeServer(files, { useNoSteam: true }));
    expect(status.switchAvailability.toWorkshop).toMatchObject({ available: false, reason: "notPublished" });
  });

  it("idInvalid when this build's published.json is broken", async () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "");
    vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", "{ broken");
    _resetWorkshopReleaseCacheForTests();
    const status = await statusFor(makeServer(files));
    expect(status.switchAvailability.toWorkshop.reason).toBe("idInvalid");
  });

  it("noSteam from the flag, a start command or the operator's own launcher", async () => {
    expect((await statusFor(makeServer(files, { useNoSteam: true }))).switchAvailability.toWorkshop.reason).toBe("noSteam");
    expect(
      (await statusFor(makeServer(files, { startCommand: "java -Dzomboid.steam=0 zombie.network.GameServer" })))
        .switchAvailability.toWorkshop.reason,
    ).toBe("noSteam");
    const launcher = path.join(files.installDir, "Launch.bat");
    fs.writeFileSync(launcher, "@echo off\r\nProjectZomboid64.exe -nosteam -servername x\r\n");
    expect(
      (await statusFor(makeServer(files, { installPath: launcher }))).switchAvailability.toWorkshop.reason,
    ).toBe("noSteam");
  });

  it("noSteam and customLauncher also come from a sibling on the same game folder", async () => {
    const other = createServerFiles(root, { key: "s2", serverName: "second", installDir: files.installDir });
    const server = makeServer(files, { id: "s1" });
    dbState.servers = [server, makeServer(other, { id: "s2", serverName: "second", isActive: false, useNoSteam: true })];
    expect((await getDeliveryStatus(server, deps())).switchAvailability.toWorkshop.reason).toBe("noSteam");

    const launcher = path.join(files.installDir, "Launch.bat");
    fs.writeFileSync(launcher, "@echo off\r\nProjectZomboid64.exe -servername second\r\n");
    dbState.servers = [server, makeServer(other, { id: "s2", serverName: "second", isActive: false, installPath: launcher })];
    const toWorkshop = (await getDeliveryStatus(server, deps())).switchAvailability.toWorkshop;
    expect(toWorkshop.available).toBe(true);
    expect(toWorkshop.warnings).toContain("customLauncher");
  });

  it("gameVersionUnsupported below Build 42, before the ini checks", async () => {
    fs.rmSync(files.iniPath);
    const status = await statusFor(makeServer(files), { modStatus: { alive: true, gameVersion: "41.78.16" } });
    expect(status.switchAvailability.toWorkshop.reason).toBe("gameVersionUnsupported");
  });

  it("iniNotFound, then iniDuplicateKeys", async () => {
    fs.rmSync(files.iniPath);
    expect((await statusFor(makeServer(files))).switchAvailability.toWorkshop.reason).toBe("iniNotFound");
    fs.writeFileSync(files.iniPath, "Mods=A\nMods=B\nWorkshopItems=\n");
    expect((await statusFor(makeServer(files))).switchAvailability.toWorkshop.reason).toBe("iniDuplicateKeys");
  });

  it("available with the standing warnings", async () => {
    runningState.value = true;
    const launcher = path.join(files.installDir, "Launch.bat");
    fs.writeFileSync(launcher, "@echo off\r\nProjectZomboid64.exe -servername x\r\n");
    const status = await statusFor(makeServer(files, { installPath: launcher }));
    expect(status.switchAvailability.toWorkshop).toEqual({
      available: true,
      reason: null,
      warnings: expect.arrayContaining(["gameVersionUnknown", "customLauncher", "serverRunning", "previewItem", "envOverride"]),
    });
    expect(status.switchAvailability.toLocal).toMatchObject({ available: false, reason: "sameMethod" });
  });

  it("sameMethod once the server is already on the Workshop", async () => {
    const status = await statusFor(switchedToWorkshop());
    expect(status.switchAvailability.toWorkshop.reason).toBe("sameMethod");
    expect(status.switchAvailability.toLocal.available).toBe(true);
  });
});

describe("checksum", () => {
  it("a missing DoLuaChecksum counts as on, which blocks players in Local mode", async () => {
    fs.writeFileSync(files.iniPath, "Mods=\n");
    const { checksum } = await statusFor(makeServer(files));
    expect(checksum).toMatchObject({ current: true, playersBlocked: true, canTurnOn: false });
    expect(checksum.turnOnBlockers).toEqual(expect.arrayContaining(["notWorkshop", "notConfirmed", "alreadyOn"]));
  });

  it("canTurnOn only once confirmed, off, and with no loose files left", async () => {
    fs.writeFileSync(files.iniPath, `Mods=${MOD}\nWorkshopItems=${WS_ID}\nDoLuaChecksum=false\n`);
    const confirmed = { modStatus: { alive: true, startedAt: 2000, delivery: { method: "workshop", workshopId: WS_ID } } };
    const ready = await statusFor(switchedToWorkshop(), confirmed);
    expect(ready.checksum).toMatchObject({ current: false, canTurnOn: true, turnOnBlockers: [], playersBlocked: false });

    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());
    expect(looseServerPath(files.installDir)).toBeTruthy();
    const leftover = await statusFor(switchedToWorkshop(), confirmed);
    expect(leftover.checksum).toMatchObject({ canTurnOn: false, turnOnBlockers: ["looseFilesPresent"] });
  });

  it("requiresLinuxAck on a non-Windows host until the Linux live test is recorded", async () => {
    const docker = await statusFor(makeServer(files, { dockerContainerName: "pz" }));
    expect(docker.hostOs).toBe("linux");
    expect(docker.checksum.requiresLinuxAck).toBe(true);
    const native = await statusFor(makeServer(files));
    expect(native.hostOs).toBe(process.platform === "win32" ? "windows" : "linux");
    expect(native.checksum.requiresLinuxAck).toBe(native.hostOs !== "windows");
  });
});
