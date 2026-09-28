/**
 * How PanelBridge reaches each server: copied into the game folder by the
 * panel ("local", the default) or downloaded by the game from the Steam
 * Workshop ("workshop", opt-in per server). This module owns the whole
 * decision and every write that follows from it:
 *
 *   - the effective method of a server (per game-install folder, see
 *     getEffectiveMethod),
 *   - GET/POST /api/panel-bridge/delivery (status, preview and apply),
 *   - reconcileBridge(), the one entry point every automatic path (boot,
 *     activation, the before-launch hook, setup, the Install button) uses to
 *     bring a game folder in line with its method -- it is the only caller
 *     of panelBridgeInstaller.installBridge(),
 *   - the guard that keeps the mod tools from dropping the bridge's
 *     Mods=/WorkshopItems= entries.
 *
 * Safety invariants (the spec's I1-I8) this file is built around:
 *   I1 the Mods= and WorkshopItems= entries are added and removed together;
 *   I2 in Workshop mode loose files leave the game folder before every panel
 *      launch, and during a switch only after the ini edit has been re-read;
 *   I3 nothing automatic writes a loose PanelBridge.lua into a Workshop
 *      folder -- the method is re-read inside the per-folder delivery lock;
 *   I4 switching to Local installs the loose file first, then removes the
 *      entries and sets DoLuaChecksum=false in ONE write per ini;
 *   I5 DoLuaChecksum=true is never written here;
 *   I6 a failed apply restores every file it touched, in reverse order, and
 *      the stored method changes only after every file step succeeded;
 *   I7 reconcile never throws and never holds a launch longer than 15 s;
 *   I8 Workshop is unavailable without Steam, below Build 42, or without an
 *      item id (and PUT /api/servers/:id refuses useNoSteam while on it).
 */
import fs from "fs";
import path from "path";
import {
  getServers,
  getActiveServer,
  getSetting,
  updateServer,
  commitNow,
} from "../database/init.js";
import { BRIDGE_MOD_ID as CONTRACT_BRIDGE_MOD_ID, DELIVERY_METHODS } from "./bridgeDeliveryContract.js";
import {
  checkBridgeInstalled,
  getBundledBridgeVersion,
  installBridge,
  resolveInstallDir,
  resolveTargetPath,
} from "./panelBridgeInstaller.js";
import {
  archiveLooseBridgeFiles,
  detectWorkshopItem,
  installDirKey,
  listLooseBridgeFiles,
  restoreArchivedBridgeFiles,
  restoreBridgeFileBytes,
} from "./bridgeDisk.js";
import { getWorkshopRelease } from "./bridgeWorkshopRelease.js";
import { resolveLaunchMode } from "./serverManager.js";
import { scanBridgeStartFailure } from "../utils/workshopLogScan.js";
import { candidateIniPaths } from "../utils/zomboidPaths.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { writeIniWithBackup } from "../utils/configBackup.js";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.js";
import {
  addBridgeEntries,
  getChecksumRawValue,
  getEffectiveChecksum,
  hasBridgeEntries,
  insertIniListEntry,
  parseIniList,
  removeBridgeEntries,
  removeIniListEntries,
  setChecksumFalse,
} from "../utils/bridgeIni.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import { isPidAlive } from "../utils/pidLiveness.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("BridgeDelivery");

export const BRIDGE_MOD_ID = CONTRACT_BRIDGE_MOD_ID;
export { installDirKey };

const RECONCILE_TIMEOUT_MS = 15_000;
// How long after a start (or the switch) the status says "waiting for
// PanelBridge to report in" before it calls the item not loaded.
const WAITING_GRACE_MS = 5 * 60 * 1000;
const LAUNCHER_SCAN_BYTES = 64 * 1024;
const NO_STEAM_RE = /-nosteam\b|zomboid\.steam=0/i;
const LIVE_DELIVERIES = new Set(["workshop", "mod", "loose"]);
const AUTO_UPDATE_REASONS = new Set(["boot", "activate", "launch"]);
const MANUAL_REMOVE_FILES = Object.freeze([
  "media/lua/server/PanelBridge.lua",
  "media/lua/client/PanelBridgeClient.lua",
]);

export class DeliveryError extends Error {
  constructor(code, status, message, params = null, restored = true) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
    this.status = status;
    this.params = params;
    this.restored = restored;
  }
}

function sameServer(a, b) {
  return a?.id !== null && a?.id !== undefined && String(a.id) === String(b?.id);
}

function displayName(server) {
  return server?.name || server?.serverName || String(server?.id ?? "");
}

export function getOwnMethod(server) {
  return server?.bridgeDelivery === "workshop" ? "workshop" : "local";
}

// Every non-remote profile whose game folder is the same folder as
// `server`'s, `server` included. Loose files live in that folder, so what
// one profile does to it happens to all of them.
export function getInstallGroup(server, allServers) {
  if (!server) return [];
  if (server.isRemote) return [server];
  const key = installDirKey(resolveInstallDir(server));
  if (!key) return [server];
  const group = (allServers || []).filter(
    (candidate) => candidate && !candidate.isRemote && installDirKey(resolveInstallDir(candidate)) === key,
  );
  if (!group.some((member) => sameServer(member, server))) group.unshift(server);
  return group;
}

// Remote profiles have no shared folder and use their own setting. For a
// local one, Workshop wins if ANY profile on the same folder chose it: a
// loose PanelBridge.lua written for a Local sibling would break the
// Workshop sibling's DoLuaChecksum (I3).
export function getEffectiveMethod(server, allServers) {
  if (!server) return "local";
  if (server.isRemote) return getOwnMethod(server);
  return getInstallGroup(server, allServers).some((member) => getOwnMethod(member) === "workshop")
    ? "workshop"
    : "local";
}

export function resolveBridgeIniPath(server) {
  const serverName = server?.serverName;
  if (!serverName) return null;
  const configDir =
    server.serverConfigPath || (server.zomboidDataPath ? path.join(server.zomboidDataPath, "Server") : null);
  return candidateIniPaths(configDir, server.zomboidDataPath, serverName).find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function readLauncherHead(launcherPath) {
  let fd;
  try {
    fd = fs.openSync(launcherPath, "r");
    const buf = Buffer.alloc(LAUNCHER_SCAN_BYTES);
    const read = fs.readSync(fd, buf, 0, LAUNCHER_SCAN_BYTES, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// A server that launches without Steam never downloads Workshop items, so
// with Workshop delivery it would start with no bridge and refuse every
// join (Mods= names a mod nobody has). The panel-generated launch scripts
// follow useNoSteam; an operator's own launcher or start command is read.
export function launchLooksNoSteam(server) {
  if (!server) return false;
  if (server.useNoSteam === true) return true;
  if (typeof server.startCommand === "string" && NO_STEAM_RE.test(server.startCommand)) return true;
  const launch = resolveLaunchMode(server);
  if (launch.mode === "custom" && launch.launcherPath) {
    return NO_STEAM_RE.test(readLauncherHead(launch.launcherPath));
  }
  return false;
}

function usesCustomLauncher(server) {
  return resolveLaunchMode(server).mode === "custom" || Boolean(String(server?.startCommand || "").trim());
}

// In-module mutex, one queue per game folder (or per remote profile). Not
// withFileLock(): that resolves its key as a filesystem path, which mangles
// a "name:D:\..." key on Windows.
const deliveryLocks = new Map();

export async function withDeliveryLock(key, fn) {
  const lockKey = String(key ?? "global");
  const prior = deliveryLocks.get(lockKey) || Promise.resolve();
  const run = prior.then(() => fn());
  const tail = run.then(
    () => {},
    () => {},
  );
  deliveryLocks.set(lockKey, tail);
  tail.finally(() => {
    if (deliveryLocks.get(lockKey) === tail) deliveryLocks.delete(lockKey);
  });
  return run;
}

function deliveryLockKey(server) {
  if (server?.isRemote) return `remote:${server.id}`;
  return installDirKey(resolveInstallDir(server)) || `server:${server?.id}`;
}

// Raw bytes (for an exact rollback) plus the text every bridgeIni helper
// expects: BOM stripped, CRLF normalized to LF.
function readIni(iniPath) {
  const raw = fs.readFileSync(iniPath);
  const text = raw.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return { raw, text };
}

function readIniTextSafe(iniPath) {
  try {
    return readIni(iniPath).text;
  } catch {
    return null;
  }
}

function isWritableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function switchRecordOf(server) {
  const record = server?.bridgeDeliverySwitch;
  return record && typeof record === "object" ? record : null;
}

// The item id this server's ini should carry: the release's when this panel
// build knows one, else the id recorded at the switch (a panel downgrade to
// a build that predates the item must not strand a working server).
function resolveEffectiveWorkshopId(server, group, release) {
  if (release.status === "published" && release.workshopId) return release.workshopId;
  const own = switchRecordOf(server)?.workshopId;
  if (own) return String(own);
  const sibling = (group || []).map((member) => switchRecordOf(member)?.workshopId).find(Boolean);
  return sibling ? String(sibling) : null;
}

// The effective method and item id together, for read-only callers that
// only need to know what SHOULD be on disk (diagnostics).
export function describeDelivery(server, allServers) {
  return {
    method: getEffectiveMethod(server, allServers),
    workshopId: resolveEffectiveWorkshopId(server, getInstallGroup(server, allServers), getWorkshopRelease()),
  };
}

function knownWorkshopIds(effectiveId, group) {
  const ids = new Set();
  if (effectiveId) ids.add(String(effectiveId));
  for (const member of group || []) {
    const id = switchRecordOf(member)?.workshopId;
    if (id) ids.add(String(id));
  }
  return [...ids];
}

function readModStatus(bridge) {
  try {
    return bridge?.getStatus?.()?.modStatus || null;
  } catch {
    return null;
  }
}

function toLive(modStatus) {
  if (!modStatus) return null;
  const delivery = modStatus.delivery && typeof modStatus.delivery === "object" ? modStatus.delivery : null;
  return {
    alive: modStatus.alive === true,
    version: typeof modStatus.version === "string" ? modStatus.version : null,
    // A bridge older than the delivery report says nothing, and it can only
    // have been the loose copy.
    delivery: LIVE_DELIVERIES.has(delivery?.method) ? delivery.method : "loose",
    workshopId: delivery?.workshopId !== undefined && delivery?.workshopId !== null ? String(delivery.workshopId) : null,
    startedAt: typeof modStatus.startedAt === "number" ? modStatus.startedAt : null,
    gameVersion: typeof modStatus.gameVersion === "string" ? modStatus.gameVersion : null,
  };
}

function gameMajorVersion(gameVersion) {
  const match = /^\s*(\d+)/.exec(String(gameVersion || ""));
  return match ? parseInt(match[1], 10) : null;
}

function resolveHostOs(server) {
  if (server?.isRemote) return "unknown";
  const provider = resolveProvider(server);
  if (provider === "docker-local" || provider === "docker-managed") return "linux";
  // macOS counts as "linux" here: the only thing hostOs drives is the
  // non-Windows-server checksum caveat.
  return process.platform === "win32" ? "windows" : "linux";
}

async function resolveServerRunning(deps) {
  if (!deps?.serverManager) return null;
  try {
    const running = await resolveObservedServerRunning(deps.serverManager, deps.rconService);
    return typeof running === "boolean" ? running : null;
  } catch {
    return null;
  }
}

function startTimeMs(serverManager) {
  const value = serverManager?.startTime;
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

// "Has the game started since the switch?" answered without comparing two
// clocks: either the panel itself saw a start after the switch, or the
// bridge reports a different startedAt than it did at switch time (a bridge
// value against a bridge value).
function computeRestartedSinceSwitch(switchRecord, serverRunning, serverManager, live) {
  if (!switchRecord) return null;
  const switchedAt = Date.parse(switchRecord.at);
  const startedAt = startTimeMs(serverManager);
  if (serverRunning === true && startedAt !== null && Number.isFinite(switchedAt) && startedAt > switchedAt) {
    return true;
  }
  if (live?.startedAt !== null && live?.startedAt !== undefined && live.startedAt !== (switchRecord.bridgeStartedAt ?? null)) {
    return true;
  }
  return false;
}

async function buildContext(server, deps = {}) {
  const all = await getServers();
  const fresh = (server?.id !== null && server?.id !== undefined && all.find((s) => sameServer(s, server))) || server;
  const release = getWorkshopRelease();
  const group = getInstallGroup(fresh, all);
  const method = getEffectiveMethod(fresh, all);
  const ownMethod = getOwnMethod(fresh);
  const installDir = fresh.isRemote ? null : resolveInstallDir(fresh);
  const access = !fresh.isRemote && installDir && isWritableDir(installDir) ? "automatic" : "guided";
  const switchRecord = switchRecordOf(fresh);
  const effectiveWorkshopId = resolveEffectiveWorkshopId(fresh, group, release);
  const modStatus = readModStatus(deps.bridge);
  const live = toLive(modStatus);
  const serverRunning = await resolveServerRunning(deps);
  const iniPath = access === "automatic" ? resolveBridgeIniPath(fresh) : null;
  const iniText = iniPath ? readIniTextSafe(iniPath) : null;
  const sharedWith = group
    .filter((member) => !sameServer(member, fresh) && member !== fresh)
    .map((member) => ({ id: String(member.id), name: displayName(member) }));
  return {
    all,
    server: fresh,
    release,
    group,
    method,
    ownMethod,
    installDir,
    access,
    switchRecord,
    effectiveWorkshopId,
    modStatus,
    live,
    serverRunning,
    iniPath,
    iniText,
    sharedWith,
    hostOs: resolveHostOs(fresh),
    deps,
  };
}

// Group ini files, one entry per distinct file, for every step that edits
// "each group ini". A member with no ini yet is reported, not an error: its
// entries are added by reconcile at its first panel launch.
function groupIniTargets(ctx) {
  const members = ctx.access === "automatic" ? ctx.group : [ctx.server];
  const targets = [];
  const missing = [];
  const seen = new Set();
  for (const member of members) {
    const iniPath = resolveBridgeIniPath(member);
    if (!iniPath) {
      if (!sameServer(member, ctx.server) && member !== ctx.server) missing.push(member);
      continue;
    }
    const key = installDirKey(iniPath);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ server: member, iniPath });
  }
  return { targets, missing };
}

function bridgeEntriesPresent(ctx) {
  const ids = knownWorkshopIds(ctx.effectiveWorkshopId, ctx.group);
  return groupIniTargets(ctx).targets.some(({ iniPath }) => {
    const text = readIniTextSafe(iniPath);
    if (text === null) return false;
    if (parseIniList(text, "Mods").entries.includes(BRIDGE_MOD_ID)) return true;
    const items = parseIniList(text, "WorkshopItems").entries;
    return ids.some((id) => items.includes(id));
  });
}

function hasDuplicateListKeys(text) {
  return findDuplicateIniKeys(text || "").some(({ key }) => key === "Mods" || key === "WorkshopItems");
}

function availabilityToWorkshop(ctx) {
  const warnings = [];
  let reason = null;
  const noSteam = launchLooksNoSteam(ctx.server);
  const major = gameMajorVersion(ctx.live?.gameVersion);
  if (ctx.method === "workshop") reason = "sameMethod";
  else if (ctx.release.status === "not-published") reason = "notPublished";
  else if (ctx.release.status === "invalid") reason = "idInvalid";
  else if (noSteam) reason = "noSteam";
  else if (major !== null && major < 42) reason = "gameVersionUnsupported";
  else if (ctx.access === "automatic" && !ctx.iniPath) reason = "iniNotFound";
  else if (
    ctx.access === "automatic" &&
    groupIniTargets(ctx).targets.some(({ iniPath }) => hasDuplicateListKeys(readIniTextSafe(iniPath)))
  ) {
    reason = "iniDuplicateKeys";
  }

  if (!ctx.live?.gameVersion) warnings.push("gameVersionUnknown");
  if (!noSteam && usesCustomLauncher(ctx.server)) warnings.push("customLauncher");
  if (ctx.sharedWith.length > 0) warnings.push("sharedInstall");
  if (ctx.serverRunning === true) warnings.push("serverRunning");
  if (ctx.release.status === "published" && ctx.release.preview) warnings.push("previewItem");
  if (ctx.release.source === "env") warnings.push("envOverride");
  return { available: reason === null, reason, warnings };
}

// Switching to Local is always possible -- including while a Workshop
// server refuses to start. "Already Local" only blocks it when there is
// nothing left to undo: a Local server whose ini still carries the bridge
// entries (a switch to Workshop that crashed before recording the method,
// or entries added by hand) can still run it to clean them up.
function availabilityToLocal(ctx, state) {
  const warnings = [];
  if (ctx.sharedWith.length > 0) warnings.push("sharedInstall");
  if (ctx.serverRunning === true) warnings.push("serverRunning");
  const cleanup = ctx.method === "local" && (state === "local-workshop-loaded" || (ctx.access === "automatic" && bridgeEntriesPresent(ctx)));
  const reason = ctx.method === "local" && !cleanup ? "sameMethod" : null;
  return { available: reason === null, reason, warnings };
}

function deriveState(ctx, { restartedSinceSwitch, lastStartFailure }) {
  const { live, method, access, serverRunning } = ctx;
  if (method === "local") {
    if (live?.alive && live.delivery === "workshop") return "local-workshop-loaded";
    if (access === "automatic") {
      const installed = checkBridgeInstalled(ctx.server);
      if (!installed.installed) return "local-not-installed";
      if (installed.needsUpdate) return "local-update-pending";
      return "local-ok";
    }
    return live?.alive ? "local-ok" : "local-unverified";
  }
  if (!ctx.effectiveWorkshopId) return "workshop-id-unknown";
  if (serverRunning === false && lastStartFailure) return "workshop-start-failed";
  if (restartedSinceSwitch === false) return "workshop-restart-needed";
  if (live?.alive && live.delivery === "workshop" && live.workshopId === ctx.effectiveWorkshopId) {
    return "workshop-confirmed";
  }
  if (live?.alive) return "workshop-not-loaded";
  if (serverRunning === false) return "workshop-stopped";
  const switchedAt = Date.parse(ctx.switchRecord?.at ?? "");
  const baseline = Math.max(startTimeMs(ctx.deps?.serverManager) ?? 0, Number.isFinite(switchedAt) ? switchedAt : 0);
  return serverRunning === true && Date.now() - baseline < WAITING_GRACE_MS
    ? "workshop-waiting"
    : "workshop-not-loaded";
}

async function statusFromContext(ctx) {
  const { server, release, method, access, effectiveWorkshopId, live, serverRunning } = ctx;
  const restartedSinceSwitch = computeRestartedSinceSwitch(
    ctx.switchRecord,
    serverRunning,
    ctx.deps?.serverManager,
    live,
  );
  const lastStartFailure =
    method === "workshop" && serverRunning === false && access === "automatic" && effectiveWorkshopId
      ? scanBridgeStartFailure(server.zomboidDataPath, effectiveWorkshopId, {
          notBefore: ctx.switchRecord?.at ?? null,
        })
      : null;
  const disk =
    access === "automatic"
      ? {
          installDir: ctx.installDir,
          looseFiles: listLooseBridgeFiles(ctx.installDir),
          iniPath: ctx.iniPath,
          iniEntries: ctx.iniText !== null ? hasBridgeEntries(ctx.iniText, BRIDGE_MOD_ID, effectiveWorkshopId) : null,
          workshopItem: effectiveWorkshopId
            ? detectWorkshopItem(ctx.installDir, effectiveWorkshopId, { zomboidDataPath: server.zomboidDataPath })
            : null,
        }
      : null;
  const state = deriveState(ctx, { restartedSinceSwitch, lastStartFailure });

  const current = access === "automatic" && ctx.iniText !== null ? getEffectiveChecksum(ctx.iniText) : null;
  const turnOnBlockers = [];
  if (method !== "workshop") turnOnBlockers.push("notWorkshop");
  if (state !== "workshop-confirmed") turnOnBlockers.push("notConfirmed");
  if (access === "automatic" && disk.looseFiles.length > 0) turnOnBlockers.push("looseFilesPresent");
  if (current === true) turnOnBlockers.push("alreadyOn");

  const modChecker = ctx.deps?.modChecker;
  let steamReportsUnavailable = false;
  try {
    steamReportsUnavailable = Boolean(effectiveWorkshopId) && modChecker?.lastUnavailableWorkshopIds?.has?.(effectiveWorkshopId) === true;
  } catch {
    steamReportsUnavailable = false;
  }

  return {
    serverId: String(server.id),
    serverName: displayName(server),
    method,
    ownMethod: ctx.ownMethod,
    state,
    access,
    hostOs: ctx.hostOs,
    sharedWith: ctx.sharedWith,
    switch: ctx.switchRecord,
    release,
    effectiveWorkshopId,
    switchAvailability: {
      toWorkshop: availabilityToWorkshop(ctx),
      toLocal: availabilityToLocal(ctx, state),
    },
    serverRunning,
    restartedSinceSwitch,
    live,
    disk,
    lastStartFailure,
    steamReportsUnavailable,
    modAutoRestart: modChecker?.autoRestartEnabled === true,
    bundledVersion: getBundledBridgeVersion(),
    checksum: {
      current,
      canTurnOn: turnOnBlockers.length === 0,
      turnOnBlockers,
      playersBlocked: method === "local" && current === true,
      requiresLinuxAck: ctx.hostOs !== "windows" && !release.linuxChecksumVerified,
    },
  };
}

export async function getDeliveryStatus(server, deps = {}) {
  const ctx = await buildContext(server, deps);
  return statusFromContext(ctx);
}

function assertMethod(to) {
  if (!DELIVERY_METHODS.includes(to)) {
    throw new DeliveryError(
      ErrorCode.PANELBRIDGE_DELIVERY_METHOD_INVALID,
      400,
      'PanelBridge delivery must be "local" or "workshop".',
    );
  }
}

function buildSteps(ctx, to, warnings) {
  const steps = [];
  const recordServers = (ctx.access === "automatic" ? ctx.group : [ctx.server]).map(displayName);
  if (ctx.access !== "automatic") {
    steps.push({ kind: "recordMethod", method: to, servers: recordServers });
    return { steps, iniTargets: [], looseFiles: [] };
  }

  const { targets, missing } = groupIniTargets(ctx);
  if (missing.length > 0) warnings.add("siblingIniMissing");
  let looseFiles = [];

  if (to === "workshop") {
    for (const { server, iniPath } of targets) {
      const text = readIniTextSafe(iniPath) ?? "";
      const present = hasBridgeEntries(text, BRIDGE_MOD_ID, ctx.effectiveWorkshopId);
      const serverName = displayName(server);
      if (!present.mods) steps.push({ kind: "iniAdd", key: "Mods", value: BRIDGE_MOD_ID, file: iniPath, serverName });
      if (!present.workshopItems) {
        steps.push({ kind: "iniAdd", key: "WorkshopItems", value: ctx.effectiveWorkshopId, file: iniPath, serverName });
      }
    }
    looseFiles = listLooseBridgeFiles(ctx.installDir);
    for (const file of looseFiles) {
      steps.push({ kind: "archiveFile", file: file.path, fileKind: file.kind, recognized: file.recognized });
      if (!file.recognized) warnings.add("unrecognizedLooseFile");
    }
  } else {
    steps.push({ kind: "installFile", file: resolveTargetPath(ctx.server), version: getBundledBridgeVersion() });
    const ids = knownWorkshopIds(ctx.effectiveWorkshopId, ctx.group);
    for (const { server, iniPath } of targets) {
      const text = readIniTextSafe(iniPath) ?? "";
      const serverName = displayName(server);
      if (parseIniList(text, "Mods").entries.includes(BRIDGE_MOD_ID)) {
        steps.push({ kind: "iniRemove", key: "Mods", value: BRIDGE_MOD_ID, file: iniPath, serverName });
      }
      const items = parseIniList(text, "WorkshopItems").entries;
      for (const id of ids) {
        if (items.includes(id)) steps.push({ kind: "iniRemove", key: "WorkshopItems", value: id, file: iniPath, serverName });
      }
      if (getEffectiveChecksum(text)) {
        steps.push({
          kind: "iniSet",
          key: "DoLuaChecksum",
          value: "false",
          before: getChecksumRawValue(text),
          file: iniPath,
          serverName,
        });
        warnings.add("checksumWillBeTurnedOff");
      }
    }
  }
  steps.push({ kind: "recordMethod", method: to, servers: recordServers });
  return { steps, iniTargets: targets, looseFiles };
}

async function planFromContext(ctx, to) {
  const status = await statusFromContext(ctx);
  const availability = to === "workshop" ? status.switchAvailability.toWorkshop : status.switchAvailability.toLocal;
  const warnings = new Set(availability.warnings);
  const { steps, iniTargets, looseFiles } = buildSteps(ctx, to, warnings);
  const manual =
    ctx.access === "guided"
      ? {
          modsEntry: BRIDGE_MOD_ID,
          workshopItemsEntry: ctx.effectiveWorkshopId,
          removeFiles: to === "workshop" ? [...MANUAL_REMOVE_FILES] : [],
          setChecksumFalse: to === "local",
        }
      : null;
  const from = ctx.method;
  return {
    plan: {
      serverId: String(ctx.server.id),
      from,
      to,
      access: ctx.access,
      blocked: availability.available ? null : { reason: availability.reason },
      steps,
      warnings: [...warnings],
      sharedWith: ctx.sharedWith,
      manual,
      applied: false,
      // An available Local-to-Local plan is the entries clean-up (see
      // availabilityToLocal), which also needs a restart to stop loading
      // the Workshop copy.
      restartRequired: to !== from || availability.available,
      backups: [],
      status,
    },
    iniTargets,
    looseFiles,
  };
}

// Preview only: reads the group's files and returns the exact steps apply
// would run, in order. Never writes anything.
export async function planDeliverySwitch(server, to, deps = {}) {
  assertMethod(to);
  const ctx = await buildContext(server, deps);
  return (await planFromContext(ctx, to)).plan;
}

function iniWriteFailed(iniPath, restored = true) {
  return new DeliveryError(
    ErrorCode.PANELBRIDGE_DELIVERY_INI_WRITE_FAILED,
    500,
    `Couldn't update ${path.basename(iniPath)}. The panel put back what it had already changed.`,
    { fileName: path.basename(iniPath) },
    restored,
  );
}

// One ini edit under the shared per-file lock (the same key mods.js and
// serverFiles.js use): backed up, written atomically with the file's own
// line ending, then re-read and verified. The undo that restores the exact
// original bytes is registered BEFORE verification, so a write that landed
// but reads back wrong is rolled back too.
async function editIni(iniPath, transform, verify, undo, backups) {
  await withFileLock(iniPath, async () => {
    let original;
    try {
      original = readIni(iniPath);
    } catch (error) {
      log.warn(`Could not read ${iniPath}: ${error.message}`);
      throw iniWriteFailed(iniPath);
    }
    const next = transform(original.text);
    if (next === original.text) {
      if (!verify(original.text)) throw iniWriteFailed(iniPath);
      return;
    }
    let backup;
    try {
      backup = await writeIniWithBackup(iniPath, next);
    } catch (error) {
      log.warn(`Could not write ${iniPath}: ${error.message}`);
      throw iniWriteFailed(iniPath);
    }
    undo.push(async () => {
      await withFileLock(iniPath, async () => writeFileAtomic(iniPath, original.raw));
    });
    backups.push({ file: iniPath, backupName: backup?.backedUp ? backup.name : null });
    const reread = readIniTextSafe(iniPath);
    if (reread === null || !verify(reread)) throw iniWriteFailed(iniPath);
  });
}

async function runUndo(undo) {
  let restored = true;
  for (const step of [...undo].reverse()) {
    try {
      await step();
    } catch (error) {
      restored = false;
      log.error(`Rollback step failed after a PanelBridge delivery switch error: ${error.message}`);
    }
  }
  return restored;
}

/**
 * Applies a switch the operator previewed. Re-plans inside the delivery
 * lock, refuses if the method moved since the preview (expectedFrom) or the
 * switch is blocked, runs every file step, and only then records the new
 * method on the profile(s). Any failure runs the registered undo steps in
 * reverse and throws a DeliveryError whose `restored` says whether every
 * rollback step succeeded (I6).
 */
export async function applyDeliverySwitch(server, to, { expectedFrom, actor = null, deps = {} } = {}) {
  assertMethod(to);
  return withDeliveryLock(deliveryLockKey(server), async () => {
    const ctx = await buildContext(server, deps);
    const { plan, iniTargets, looseFiles } = await planFromContext(ctx, to);
    if (plan.from !== expectedFrom) {
      throw new DeliveryError(
        ErrorCode.PANELBRIDGE_DELIVERY_STALE,
        409,
        `PanelBridge delivery for this server changed since you opened this page (now: ${plan.from}). Review the steps again.`,
        { current: plan.from },
      );
    }
    if (plan.blocked) {
      throw new DeliveryError(
        ErrorCode.PANELBRIDGE_DELIVERY_UNAVAILABLE,
        400,
        `This change isn't available for this server right now (${plan.blocked.reason}).`,
        { reason: plan.blocked.reason },
      );
    }

    const undo = [];
    const backups = [];
    const id = ctx.effectiveWorkshopId;
    try {
      if (ctx.access === "automatic" && to === "workshop") {
        // I2: the ini edit is written and re-read BEFORE any loose file
        // moves, so a failed ini write never leaves a folder with no bridge.
        for (const { iniPath } of iniTargets) {
          await editIni(
            iniPath,
            (text) => addBridgeEntries(text, BRIDGE_MOD_ID, id),
            (text) => {
              const present = hasBridgeEntries(text, BRIDGE_MOD_ID, id);
              return present.mods && present.workshopItems;
            },
            undo,
            backups,
          );
        }
        if (looseFiles.length > 0) {
          let archived;
          try {
            archived = await archiveLooseBridgeFiles(ctx.installDir, looseFiles, { reason: "switch-to-workshop" });
          } catch (error) {
            log.warn(`Could not move PanelBridge files out of ${ctx.installDir}: ${error.message}`);
            throw new DeliveryError(
              ErrorCode.PANELBRIDGE_DELIVERY_FILE_ARCHIVE_FAILED,
              500,
              `Couldn't move ${error.fileName || "a PanelBridge file"} out of the game folder. Check its permissions and try again. The panel put back what it had already changed.`,
              { fileName: error.fileName || null },
            );
          }
          undo.push(() => restoreArchivedBridgeFiles(archived));
        }
      } else if (ctx.access === "automatic" && to === "local") {
        // I4: the loose file is installed and verified first; only then do
        // the entries go, in one write per ini that also turns the Lua
        // integrity check off (with the loose copy, players can't join
        // while it's on).
        const targetPath = resolveTargetPath(ctx.server);
        let previousBytes = null;
        try {
          previousBytes = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
        } catch {
          previousBytes = null;
        }
        const installed = installBridge(ctx.server);
        if (!installed.success || !checkBridgeInstalled(ctx.server).installed) {
          log.warn(`PanelBridge install during switch to panel-installed failed: ${installed.error || "not found after install"}`);
          throw new DeliveryError(
            ErrorCode.PANELBRIDGE_DELIVERY_INSTALL_FAILED,
            500,
            "Couldn't copy PanelBridge.lua into the game folder. Nothing was changed.",
          );
        }
        if (installed.updated) {
          undo.push(async () => {
            if (previousBytes) {
              restoreBridgeFileBytes(targetPath, previousBytes);
            } else {
              await archiveLooseBridgeFiles(
                ctx.installDir,
                [{ path: targetPath, kind: "server", recognized: true }],
                { reason: "switch-to-local-rollback" },
              );
            }
          });
        }
        const ids = knownWorkshopIds(id, ctx.group);
        for (const { iniPath } of iniTargets) {
          await editIni(
            iniPath,
            (text) => setChecksumFalse(removeBridgeEntries(text, BRIDGE_MOD_ID, ids)),
            (text) => {
              const mods = parseIniList(text, "Mods").entries;
              const items = parseIniList(text, "WorkshopItems").entries;
              return (
                !mods.includes(BRIDGE_MOD_ID) && !ids.some((entry) => items.includes(entry)) && !getEffectiveChecksum(text)
              );
            },
            undo,
            backups,
          );
        }
      }

      const record = {
        to,
        at: new Date().toISOString(),
        by: actor ?? null,
        bridgeStartedAt: typeof ctx.modStatus?.startedAt === "number" ? ctx.modStatus.startedAt : null,
        workshopId: to === "workshop" ? id : null,
      };
      const members = (ctx.access === "automatic" ? ctx.group : [ctx.server]).filter(
        (member) => member?.id !== null && member?.id !== undefined,
      );
      const previous = members.map((member) => ({
        id: member.id,
        bridgeDelivery: member.bridgeDelivery,
        bridgeDeliverySwitch: member.bridgeDeliverySwitch,
      }));
      // The in-memory rows are what the panel reads, so putting them back is
      // the rollback; the flush after it is best-effort (if committing is what
      // failed, db.json never received the new values in the first place, and
      // the next scheduled write persists the restored rows).
      undo.push(async () => {
        for (const entry of previous) {
          await updateServer(entry.id, {
            bridgeDelivery: entry.bridgeDelivery,
            bridgeDeliverySwitch: entry.bridgeDeliverySwitch,
          });
        }
        try {
          await commitNow();
        } catch (error) {
          log.warn(`Could not flush the restored PanelBridge delivery settings: ${error.message}`);
        }
      });
      for (const member of members) {
        await updateServer(member.id, { bridgeDelivery: to, bridgeDeliverySwitch: record });
      }
      await commitNow();
    } catch (error) {
      const restored = await runUndo(undo);
      if (error instanceof DeliveryError) {
        error.restored = restored;
        throw error;
      }
      log.error(`PanelBridge delivery switch failed: ${error.message}`);
      throw new DeliveryError(null, 500, "The PanelBridge delivery switch failed.", null, restored);
    }

    log.info(
      `PanelBridge delivery for ${displayName(ctx.server)} switched ${plan.from} -> ${to}` +
        `${ctx.sharedWith.length ? ` (with ${ctx.sharedWith.map((s) => s.name).join(", ")})` : ""}` +
        ` by ${actor || "unknown"} (${ctx.access})`,
    );
    const status = await getDeliveryStatus(ctx.server, deps);
    return { ...plan, applied: true, backups, status };
  });
}

function removeStaleTempFiles(installDir, actions) {
  const serverDir = path.join(installDir, "media", "lua", "server");
  let names = [];
  try {
    names = fs.readdirSync(serverDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^\.PanelBridge\.lua\.tmp\.(\d+)$/i.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    // This process's own temp can only be a leftover here: every write of
    // it runs inside this same lock. Another live panel process (a
    // supervised restart overlaps two) may still be mid-write.
    if (pid !== process.pid && isPidAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(serverDir, name));
      actions.push({ kind: "tempRemoved", path: path.join(serverDir, name) });
    } catch {
      /* best-effort */
    }
  }
}

async function reconcileWorkshopIni(fresh, id, actions, warnings) {
  const iniPath = resolveBridgeIniPath(fresh);
  if (!iniPath) {
    warnings.push("iniMissing");
    return;
  }
  try {
    await withFileLock(iniPath, async () => {
      const { text } = readIni(iniPath);
      let next = addBridgeEntries(text, BRIDGE_MOD_ID, id);
      const added = next !== text;
      // The release moved to a new item id (a panel update after the item
      // had to be re-published): swap the old WorkshopItems entry for the
      // new one instead of leaving both.
      const oldId = switchRecordOf(fresh)?.workshopId;
      let migrated = false;
      if (oldId && String(oldId) !== id) {
        const withoutOld = removeIniListEntries(next, "WorkshopItems", [String(oldId)]);
        migrated = withoutOld !== next;
        next = withoutOld;
      }
      if (next === text) return;
      await writeIniWithBackup(iniPath, next);
      const present = hasBridgeEntries(readIni(iniPath).text, BRIDGE_MOD_ID, id);
      if (!present.mods || !present.workshopItems) {
        warnings.push("iniWriteFailed");
        return;
      }
      if (added) actions.push({ kind: "iniEntriesAdded", path: iniPath });
      if (migrated) actions.push({ kind: "iniEntryMigrated", path: iniPath });
    });
  } catch (error) {
    log.warn(`Could not update ${iniPath} for PanelBridge: ${error.message}`);
    warnings.push("iniWriteFailed");
  }
}

async function reconcileInner(server, reason) {
  if (!server) return { method: null, skipped: "noServer", actions: [], warnings: [] };
  if (server.isRemote) return { method: null, skipped: "remote", actions: [], warnings: [] };
  const installDir = resolveInstallDir(server);
  if (!installDir || !fs.existsSync(installDir)) {
    return { method: null, skipped: "noInstallDir", actions: [], warnings: [] };
  }

  return withDeliveryLock(installDirKey(installDir), async () => {
    // Re-read inside the lock (I3): a switch applied a moment ago must be
    // what this reconcile acts on. A setup pseudo-record (id null) has no
    // row yet and is used as given.
    const all = await getServers();
    const fresh =
      (server.id !== null && server.id !== undefined && all.find((candidate) => sameServer(candidate, server))) ||
      server;
    const method = getEffectiveMethod(fresh, all);
    const actions = [];
    const warnings = [];

    removeStaleTempFiles(installDir, actions);

    // Files older panels wrote next to the server Lua. They never did
    // anything from the game folder, and they break DoLuaChecksum.
    const legacy = listLooseBridgeFiles(installDir).filter(
      (file) => file.recognized && (file.kind === "client" || file.kind === "rootModInfo"),
    );
    if (legacy.length > 0) {
      try {
        const archived = await archiveLooseBridgeFiles(installDir, legacy, { reason: `legacy-${reason}` });
        for (const moved of archived.moved) actions.push({ kind: "legacyArchived", path: moved });
      } catch (error) {
        log.warn(`Could not archive legacy PanelBridge files in ${installDir}: ${error.message}`);
        warnings.push("archiveFailed");
      }
    }

    if (method === "local") {
      if (AUTO_UPDATE_REASONS.has(reason) && (await getSetting("panelBridgeAutoUpdate")) === false) {
        warnings.push("autoUpdateOff");
      } else {
        const installed = checkBridgeInstalled(fresh);
        if (!installed.installed || installed.needsUpdate) {
          const result = installBridge(fresh);
          if (!result.success) warnings.push("installFailed");
          else if (result.updated) {
            actions.push({ kind: installed.installed ? "updated" : "installed", path: result.targetPath });
          }
        }
      }
    } else {
      const loose = listLooseBridgeFiles(installDir).filter((file) => file.kind === "server" || file.kind === "client");
      if (loose.length > 0) {
        try {
          const archived = await archiveLooseBridgeFiles(installDir, loose, { reason: `workshop-${reason}` });
          for (const moved of archived.moved) actions.push({ kind: "archived", path: moved });
        } catch (error) {
          log.warn(`Could not move loose PanelBridge files out of ${installDir}: ${error.message}`);
          warnings.push("archiveFailed");
        }
      }
      const id = resolveEffectiveWorkshopId(fresh, getInstallGroup(fresh, all), getWorkshopRelease());
      if (!id) warnings.push("workshopIdUnknown");
      else if (launchLooksNoSteam(fresh)) warnings.push("noSteam");
      else await reconcileWorkshopIni(fresh, id, actions, warnings);
    }

    const summary =
      `PanelBridge reconcile (${reason}) for ${displayName(fresh) || installDir}: method=${method}` +
      `; actions=[${actions.map((action) => action.kind).join(", ")}]` +
      `; warnings=[${warnings.join(", ")}]`;
    if (warnings.length > 0) log.warn(summary);
    else log.info(summary);
    return { method, skipped: null, actions, warnings };
  });
}

/**
 * Brings `server`'s game folder in line with its effective delivery method:
 * Local keeps the loose PanelBridge.lua current; Workshop moves loose files
 * out and makes sure this server's ini lists the item. Never throws and
 * never takes longer than `timeoutMs` from the caller's point of view (I7):
 * a launch waits for this at most 15 s, then goes ahead.
 */
export async function reconcileBridge(server, { reason = "manual", timeoutMs = RECONCILE_TIMEOUT_MS } = {}) {
  const failed = { method: null, skipped: null, actions: [], warnings: ["installFailed"] };
  let work;
  try {
    work = reconcileInner(server, reason).catch((error) => {
      log.error(`PanelBridge reconcile (${reason}) failed: ${error.message}`);
      return failed;
    });
  } catch (error) {
    log.error(`PanelBridge reconcile (${reason}) failed: ${error.message}`);
    return failed;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      log.warn(`PanelBridge reconcile (${reason}) took longer than ${timeoutMs} ms; not waiting for it`);
      resolve({ method: null, skipped: "timeout", actions: [], warnings: [] });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function activeWorkshopContext() {
  const active = await getActiveServer();
  if (!active) return null;
  const all = await getServers();
  if (getEffectiveMethod(active, all) !== "workshop") return null;
  const workshopId = resolveEffectiveWorkshopId(active, getInstallGroup(active, all), getWorkshopRelease());
  return workshopId ? { active, workshopId } : null;
}

/**
 * The mods.js ini guard: when the active server gets PanelBridge from the
 * Workshop, a mod-tool write that would drop the bridge's Mods= or
 * WorkshopItems= entry (remove, toggle, collection import, load-order save)
 * gets the entry put back at its old position. It never adds an entry that
 * `before` didn't have, and keeps any reorder. Fails open -- a lookup error
 * returns `after` unchanged, and the next launch's reconcile re-adds the
 * entries -- because this sits in front of every mod edit the operator makes.
 */
export async function protectBridgeIniEntries(iniPath, before, after) {
  let context;
  try {
    context = await activeWorkshopContext();
  } catch (error) {
    log.debug(`PanelBridge ini guard skipped (${iniPath}): ${error.message}`);
    return after;
  }
  if (!context) return after;
  const beforeText = String(before ?? "").replace(/\r\n/g, "\n");
  let result = String(after ?? "");
  for (const [key, value] of [
    ["Mods", BRIDGE_MOD_ID],
    ["WorkshopItems", context.workshopId],
  ]) {
    const oldEntries = parseIniList(beforeText, key).entries;
    const oldIndex = oldEntries.indexOf(value);
    if (oldIndex === -1) continue;
    const normalized = result.replace(/\r\n/g, "\n");
    if (parseIniList(normalized, key).entries.includes(value)) continue;
    result = insertIniListEntry(normalized, key, value, oldIndex);
    log.info(`Kept PanelBridge's ${key} entry (managed in Settings › PanelBridge)`);
  }
  return result;
}

// GET /api/mods/current-config's bridgeManaged: which Mods/WorkshopItems
// entries the Mods page shows as managed elsewhere. Never throws.
export async function getBridgeManaged() {
  try {
    const context = await activeWorkshopContext();
    return context ? { modId: BRIDGE_MOD_ID, workshopId: context.workshopId } : null;
  } catch (error) {
    log.debug(`Could not resolve PanelBridge Workshop entries: ${error.message}`);
    return null;
  }
}
