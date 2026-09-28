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
 *      item id (and PUT/POST /api/servers and the setup routes refuse a
 *      profile that launches without Steam in a Workshop game folder, and
 *      PUT refuses moving a Workshop profile next to one that does).
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
  readBridgeFileMeta,
  restoreArchivedBridgeFiles,
  restoreBridgeFileBytes,
} from "./bridgeDisk.js";
import { getWorkshopRelease } from "./bridgeWorkshopRelease.js";
import { parseCustomStartCommand, resolveLaunchMode } from "./serverManager.js";
import { scanBridgeStartFailure, scanSteamStartup } from "../utils/workshopLogScan.js";
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
  listsIniEntry,
  parseIniList,
  readGameIniList,
  removeBridgeEntries,
  removeIniListEntries,
  setChecksumFalse,
} from "../utils/bridgeIni.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import { isPlausibleStartMs } from "../utils/processStartTime.js";
import { resolveDockerHostSignal } from "./managedContainer.js";
import { isPidAlive } from "../utils/pidLiveness.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { LIFECYCLE_IN_PROGRESS_CODE } from "./lifecycleCoordinator.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("BridgeDelivery");

export const BRIDGE_MOD_ID = CONTRACT_BRIDGE_MOD_ID;
export { installDirKey };

const RECONCILE_TIMEOUT_MS = 15_000;
// How long an apply waits behind a reconcile of the same game folder. The
// route holds the global lifecycle lock meanwhile (every start, stop and
// restart is refused), and the Settings page gives up on its request after
// 15 s: a bounded wait answers with a coded 409 before either goes wrong. A
// reconcile that timed out keeps the folder's lock until its disk work ends,
// which on a dead network share could be never.
const APPLY_LOCK_WAIT_MS = 10_000;
// How long after a start (or the switch) the status says "waiting for
// PanelBridge to report in" before it calls the item not loaded.
const WAITING_GRACE_MS = 5 * 60 * 1000;
const LAUNCHER_SCAN_BYTES = 64 * 1024;
const NO_STEAM_RE = /-nosteam\b|zomboid\.steam=0/i;
// Steam is opt-in for the game: 42.21's SteamUtils.init turns it on only when
// the java system property zomboid.steam is "1". A launch that runs the
// server's main class itself must pass -Dzomboid.steam=1 (the panel's own
// scripts and the dedicated server's StartServer64.bat do; the client
// install's ProjectZomboidServer.bat doesn't), or the server silently runs
// without Steam and never downloads a Workshop item. A launch that goes
// through ProjectZomboid64 / start-server.sh names no main class: its flags
// live in ProjectZomboid64.json, which this doesn't judge.
const STEAM_ON_RE = /zomboid\.steam=1(?!\d)/i;
const GAME_SERVER_MAIN_RE = /zombie\.network\.GameServer\b/;
// The start command's own script is read only when it is one (never a
// binary): the extensions serverManager.startServer() runs, minus .exe.
const START_SCRIPT_EXTENSIONS = new Set([".bat", ".cmd", ".sh"]);
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
    // codeql[js/path-injection] launcherPath is either serverManager.resolveLaunchMode()'s custom launcher (the profile's own serverPath/installPath ending in .bat/.sh/.exe, an operator setting accepted only by the servers.manage / server.install routes: POST /api/servers' validateInstallPathShape; /install and /quick-setup's isValidPath: absolute, no "..") or the .bat/.cmd/.sh script of the profile's own startCommand (servers.manage only), resolved against the install folder as serverManager.startServer() does -- in both cases the very script the panel launches as-is. This only reads its first 64 KB to test NO_STEAM_RE and the Steam flag, and returns nothing but those booleans.
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

// The script a custom start command runs, when it is one: its command
// resolved against the install folder, as serverManager.startServer() does.
function startCommandScript(server, startCommand) {
  const { cmd } = parseCustomStartCommand(startCommand);
  if (!cmd || !START_SCRIPT_EXTENSIONS.has(path.extname(cmd).toLowerCase())) return null;
  if (path.isAbsolute(cmd)) return cmd;
  const base = resolveInstallDir(server);
  return base ? path.resolve(base, cmd) : null;
}

// What an operator's own launch hands the game, as far as the panel can
// read it: the start command, the head of the script it runs, and the head
// of a custom launcher (a serverPath/installPath naming a script). "" for a
// managed launch -- the panel writes that script itself, following
// useNoSteam and always passing zomboid.steam.
function readLaunchText(server) {
  const parts = [];
  const startCommand = typeof server.startCommand === "string" ? server.startCommand.trim() : "";
  if (startCommand) {
    parts.push(startCommand);
    const script = startCommandScript(server, startCommand);
    if (script) parts.push(readLauncherHead(script));
  }
  const launch = resolveLaunchMode(server);
  if (launch.mode === "custom" && launch.launcherPath) parts.push(readLauncherHead(launch.launcherPath));
  return parts.join("\n");
}

// A server that launches without Steam never downloads Workshop items, so
// with Workshop delivery it would start with no bridge and refuse every
// join (Mods= names a mod nobody has). The panel-generated launch scripts
// follow useNoSteam; an operator's own launcher or start command (and the
// script that one runs) is read.
export function launchLooksNoSteam(server) {
  if (!server) return false;
  if (server.useNoSteam === true) return true;
  return NO_STEAM_RE.test(readLaunchText(server));
}

// The quieter way to the same result: an operator's own launch that runs
// the server's main class without -Dzomboid.steam=1 (see STEAM_ON_RE). Not
// a block like launchLooksNoSteam() -- the panel reads only the first 64 KB
// of a script, and a script may set the flag in a way this can't see -- but
// named in the switch preview's warnings and on the Workshop status.
export function launchSkipsSteam(server) {
  if (!server || server.useNoSteam === true) return false;
  const text = readLaunchText(server);
  return GAME_SERVER_MAIN_RE.test(text) && !STEAM_ON_RE.test(text) && !NO_STEAM_RE.test(text);
}

// The profiles of `server`'s install group that launch without Steam while
// the group gets PanelBridge from the Workshop. Each one's launch archives
// the shared loose file and skips its own ini (reconcile's noSteam
// warning): it runs with no bridge at all. A remote profile is its own group.
function noSteamWorkshopMembers(server, allServers) {
  if (!server || getEffectiveMethod(server, allServers) !== "workshop") return [];
  return getInstallGroup(server, allServers).filter((member) => launchLooksNoSteam(member));
}

/**
 * I8 for a change to the server profiles: `before` is the stored record
 * (null for a profile that has no row yet: POST /api/servers, the setup
 * wizard, quick setup) and `after` the record as it would be saved.
 * Returns the profiles the change would leave launching without Steam in a
 * game folder that gets PanelBridge from the Steam Workshop, split into
 * `self` (the changed profile: useNoSteam, a -nosteam start command or
 * launcher, a move into a Workshop folder) and `siblings` (a Workshop
 * profile moved -- installPath, serverPath, or remote to local -- into a
 * folder another profile launches without Steam from: the folder decides,
 * so that one turns Workshop too). Only conflicts the change creates count:
 * the edit dialog saves the whole record, so a profile already in that
 * state must stay renameable.
 */
export function findNoSteamWorkshopConflicts(before, after, allServers) {
  const all = allServers || [];
  const isChanged = (member) => member === after || (before !== null && sameServer(member, before));
  const afterAll = before ? all.map((candidate) => (sameServer(candidate, before) ? after : candidate)) : all;
  const conflictedBefore = (member) => {
    const prior = isChanged(member) ? before : member;
    return Boolean(prior) && launchLooksNoSteam(prior) && getEffectiveMethod(prior, all) === "workshop";
  };
  const created = noSteamWorkshopMembers(after, afterAll).filter((member) => !conflictedBefore(member));
  return { self: created.some(isChanged), siblings: created.filter((member) => !isChanged(member)) };
}

// The same check for a profile about to be created, which has no row yet.
// A new profile is never Workshop by its own choice, so only `self` can
// apply to it.
export function newProfileConflictsWithWorkshop(candidate, allServers) {
  if (!candidate || candidate.isRemote) return false;
  return findNoSteamWorkshopConflicts(null, { ...candidate, id: null, isRemote: false }, allServers).self;
}

// The 409 body for a changed profile that would launch without Steam in a
// Workshop game folder: PUT/POST /api/servers and the two setup routes.
export function noSteamWorkshopConflictResponse() {
  return {
    error:
      "This server gets PanelBridge from the Steam Workshop, which needs Steam. Switch PanelBridge to panel-installed in Settings › PanelBridge before turning on Launch without Steam.",
    code: ErrorCode.SERVER_NOSTEAM_CONFLICTS_WITH_WORKSHOP_BRIDGE,
  };
}

// The 409 body when the edit is a Workshop profile moving next to profiles
// that launch without Steam (PUT /api/servers/:id), naming them.
export function noSteamSiblingConflictResponse(siblings) {
  const names = (siblings || []).map(displayName).join(", ");
  return {
    error: `This server gets PanelBridge from the Steam Workshop, which needs Steam, and every server sharing a game folder gets it the same way. These servers in that folder launch without Steam: ${names}. First switch this server's PanelBridge to panel-installed in Settings › PanelBridge, or have them launch with Steam.`,
    code: ErrorCode.SERVER_NOSTEAM_SIBLING_CONFLICTS_WITH_WORKSHOP_BRIDGE,
    params: { names },
  };
}

function usesCustomLauncher(server) {
  return resolveLaunchMode(server).mode === "custom" || Boolean(String(server?.startCommand || "").trim());
}

// In-module mutex, one queue per game folder (or per remote profile). Not
// withFileLock(): that resolves its key as a filesystem path, which mangles
// a "name:D:\..." key on Windows.
//
// `waitMs` bounds how long a caller waits for its turn. When it runs out the
// caller gets a 409 and its `fn` is dropped for good (never run later, out
// of context). The dropped turn still keeps its place in the queue, so
// nothing behind it can overtake the holder.
const deliveryLocks = new Map();

function deliveryLockBusy() {
  return new DeliveryError(
    LIFECYCLE_IN_PROGRESS_CODE,
    409,
    "PanelBridge is being updated in this game folder right now (for example before a server start). Try again in a moment.",
  );
}

export async function withDeliveryLock(key, fn, { waitMs = null } = {}) {
  const lockKey = String(key ?? "global");
  const prior = deliveryLocks.get(lockKey) || Promise.resolve();
  let timer = null;
  let abandoned = false;
  const run = prior.then(() => {
    if (abandoned) return undefined;
    clearTimeout(timer);
    return fn();
  });
  const tail = run.then(
    () => {},
    () => {},
  );
  deliveryLocks.set(lockKey, tail);
  tail.finally(() => {
    if (deliveryLocks.get(lockKey) === tail) deliveryLocks.delete(lockKey);
  });
  if (!(waitMs > 0)) return run;
  const gaveUp = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(deliveryLockBusy());
    }, waitMs);
    timer.unref?.();
  });
  return Promise.race([run, gaveUp]);
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

// When the running game started, in epoch ms, or null when unknown -- what
// the three start-time comparisons below (restartedSinceSwitch, the
// previous-run heartbeat, the Workshop waiting grace) measure against; all
// three use it only while the server runs.
//
// For a native server that is serverManager.startTime (see
// PREVIOUS_RUN_SLACK_MS). A Docker server's never lands there: its starts
// go through the container (runManagedLifecycle, no launch record), and the
// process scan behind resolveStartTime() can't see a process in another
// container. The container's own State.StartedAt, from the same inspect the
// Dashboard's uptime reads (runningContainerSignal()), is that start as
// long as PZ runs as the container's main process; it is only asked for
// while the server runs. An image that relaunches PZ inside a container
// that stays up gives an older time, which only makes the comparisons fall
// back to the bridge's own startedAt and the switch time. Without it, a
// Docker restart long after a switch measured the waiting grace from the
// switch and showed "Not loaded from the Workshop" through the new run's
// world load, and the previous run's heartbeat went unrecognised.
async function resolveGameStartMs(server, deps, serverRunning) {
  const provider = resolveProvider(server);
  if (provider !== "docker-local" && provider !== "docker-managed") {
    return startTimeMs(deps?.serverManager);
  }
  if (serverRunning !== true) return null;
  try {
    const signal = await resolveDockerHostSignal(server, deps?.dockerClient);
    if (signal?.scanFailed || !signal?.running || !signal.startedAt) return null;
    const ms = Date.parse(signal.startedAt);
    return isPlausibleStartMs(ms) ? ms : null;
  } catch (error) {
    log.debug(`Could not read the container's start time: ${error.message}`);
    return null;
  }
}

// "Has the game started since the switch?" Either the game's start time
// (resolveGameStartMs()) is after the switch, or the bridge reports a
// different startedAt than it did at switch time -- a bridge value against
// a bridge value, so no two clocks are compared.
//
// That baseline only exists on the record of the profile whose bridge was
// read at switch time (see applyDeliverySwitch). A sibling on the same game
// folder, or a server whose bridge wasn't reporting, has none, and "any
// startedAt at all" would count the run that was already going before the
// switch as a restart (state workshop-not-loaded instead of
// workshop-restart-needed). A non-remote game runs on the panel's host, so
// its startedAt and the switch time share one clock and can be compared
// directly. A remote host's clock can't be trusted against the panel's; it
// keeps the plain rule.
function computeRestartedSinceSwitch(switchRecord, serverRunning, startedAt, live, isRemote) {
  if (!switchRecord) return null;
  const switchedAt = Date.parse(switchRecord.at);
  if (serverRunning === true && startedAt !== null && Number.isFinite(switchedAt) && startedAt > switchedAt) {
    return true;
  }
  if (live?.startedAt === null || live?.startedAt === undefined) return false;
  const baseline = typeof switchRecord.bridgeStartedAt === "number" ? switchRecord.bridgeStartedAt : null;
  if (baseline !== null) return live.startedAt !== baseline;
  if (isRemote) return true;
  return Number.isFinite(switchedAt) && live.startedAt > switchedAt;
}

// Slack for the one clock comparison below: serverManager.startTime is the
// OS's start time for the game process (resolveStartTime()) or, until a
// status check has asked the OS, the moment the panel launched it, which can
// land a moment after the real start. (A Docker server's is its container's
// start, which comes before the game's.) A new run's bridge reports in far
// later than that (the world has to load first), so a few seconds cost
// nothing.
const PREVIOUS_RUN_SLACK_MS = 5_000;

// Whether the heartbeat on hand was written by an EARLIER game run than the
// one the state is about. status.json keeps reading as alive for a while
// after its run ends (services/panelBridge.js: 45 s, or 5 minutes when it
// last reported nobody online). The panel pins it as dead only when it sees
// the process exit (PanelBridge.markServerExited()): its own stops and
// restarts do, on their verified stop, but a remote host, or a restart the
// panel didn't drive (a service manager or container respawn) between two
// status-watchdog ticks, never gives it that -- so right after such a
// restart it can still be the previous run's, which says nothing about how
// the run now starting loads PanelBridge. It is the
// previous run's when:
//   - the game hasn't started since the switch at all;
//   - the bridge's own startedAt is the one recorded at switch time (the run
//     that was going when the operator switched; bridge value against
//     bridge value, no clock involved);
//   - on the panel's host, the run started before the panel's latest start
//     of this server (one clock -- the same assumption
//     computeRestartedSinceSwitch makes for a profile with no baseline).
function heartbeatFromPreviousRun(ctx, restartedSinceSwitch) {
  const { live, switchRecord } = ctx;
  if (!live) return false;
  if (switchRecord && restartedSinceSwitch === false) return true;
  if (live.startedAt === null) return false;
  if (typeof switchRecord?.bridgeStartedAt === "number" && live.startedAt === switchRecord.bridgeStartedAt) {
    return true;
  }
  if (ctx.server.isRemote) return false;
  const started = ctx.gameStartedAtMs;
  return ctx.serverRunning === true && started !== null && live.startedAt < started - PREVIOUS_RUN_SLACK_MS;
}

// A settings file that makes the game load the bridge's mod copy (its id in
// the Mods= list the game reads) with the Lua integrity check on. The mod
// copy then runs whether or not a loose PanelBridge.lua sits in the game
// folder -- same path, only one of them runs -- and a loose one only adds
// files players don't have, so every non-admin join is refused (§3). On a
// Local server this is how a joinable Workshop setup can end up, with no
// switch involved: the Workshop profile that shared the folder was deleted
// or moved, or the running game re-saved its in-memory options over the
// file after a "Switch, restart later" back to panel-installed (RCON
// changeoption: 42.20 ServerOptions.changeOption -> saveServerTextFile,
// which writes every option), or an older ini came back from a restore.
function workshopCopyWithChecksumOn(iniText) {
  if (iniText === null || iniText === undefined) return false;
  return readGameIniList(iniText, "Mods").entries.includes(BRIDGE_MOD_ID) && getEffectiveChecksum(iniText);
}

function isLooseLua(file) {
  return file.kind === "server" || file.kind === "client";
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
  const gameStartedAtMs = await resolveGameStartMs(fresh, deps, serverRunning);
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
    gameStartedAtMs,
    iniPath,
    iniText,
    sharedWith,
    hostOs: resolveHostOs(fresh),
    deps,
  };
}

// The profiles a switch records its method on: exactly the ones
// getEffectiveMethod() decides together, whatever the access. That is the
// whole install group of a non-remote profile (a remote one is its own
// group). Guided access covers non-remote profiles too -- an install folder
// that is missing or read-only, Docker-managed without a host mount -- and
// recording only the active one there left a sibling's own "workshop"
// deciding the folder: a switch back answered "switched" and changed
// nothing, for good.
function recordMembers(ctx) {
  return ctx.group.filter((member) => member?.id !== null && member?.id !== undefined);
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

// Whether a switch to Local would take anything out of a group ini: the
// same matching the removal uses, on every Mods=/WorkshopItems= line (the
// removal cleans duplicates too, and the game reads the last one).
function bridgeEntriesPresent(ctx) {
  const ids = knownWorkshopIds(ctx.effectiveWorkshopId, ctx.group);
  return groupIniTargets(ctx).targets.some(({ iniPath }) => {
    const text = readIniTextSafe(iniPath);
    if (text === null) return false;
    if (listsIniEntry(text, "Mods", BRIDGE_MOD_ID)) return true;
    return ids.some((id) => listsIniEntry(text, "WorkshopItems", id));
  });
}

function hasDuplicateListKeys(text) {
  return findDuplicateIniKeys(text || "").some(({ key }) => key === "Mods" || key === "WorkshopItems");
}

function availabilityToWorkshop(ctx) {
  const warnings = [];
  let reason = null;
  // Checked across the whole install group, not just this profile: the
  // switch makes every profile on the folder Workshop, writes the entries
  // into each one's ini and moves the shared loose file out. A sibling that
  // launches without Steam would then start with no bridge and, with Mods=
  // naming the item, refuse every join. Same for the custom-launcher caveat.
  const noSteam = ctx.group.some((member) => launchLooksNoSteam(member));
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
  // A launch read as leaving -Dzomboid.steam=1 out gets the warning that
  // names the flag; any other operator launch the "if it runs without
  // Steam" one.
  if (!noSteam && ctx.group.some((member) => launchSkipsSteam(member))) warnings.push("steamFlagMissing");
  else if (!noSteam && ctx.group.some((member) => usesCustomLauncher(member))) warnings.push("customLauncher");
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
// or entries added by hand), or whose current run loads the Workshop copy,
// can still run it to clean them up. The run from before a switch back to
// Local doesn't count (deriveState): its switch already removed the
// entries, and offering the same switch again would only rewrite the record.
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
  const previousRun = heartbeatFromPreviousRun(ctx, restartedSinceSwitch);
  if (method === "local") {
    // The run from before a switch back to panel-installed still reports the
    // Workshop copy until the game restarts ("Switch, restart later"); that
    // is the switch not having taken effect yet, which the folder below and
    // the restart note on the page describe, not a Workshop copy the
    // settings still ask for.
    if (live?.alive && live.delivery === "workshop" && !previousRun) return "local-workshop-loaded";
    if (access === "automatic") {
      // What the next start loads, read from the settings file: reconcile
      // keeps the game folder free of a loose copy next to that mod copy
      // (reconcileInner), so "not installed" / "Install now" would be the
      // wrong advice. The remedy is the same as for a heartbeat that says
      // so: make the Workshop official, or clean the entries up.
      if (workshopCopyWithChecksumOn(ctx.iniText)) return "local-workshop-loaded";
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
  // An earlier run's heartbeat says nothing about this one: the state stays
  // "waiting" (and the page keeps polling) until the new run reports in.
  const current = live?.alive && !previousRun ? live : null;
  if (current && current.delivery === "workshop" && current.workshopId === ctx.effectiveWorkshopId) {
    return "workshop-confirmed";
  }
  if (current) return "workshop-not-loaded";
  if (serverRunning === false) return "workshop-stopped";
  const switchedAt = Date.parse(ctx.switchRecord?.at ?? "");
  const baseline = Math.max(ctx.gameStartedAtMs ?? 0, Number.isFinite(switchedAt) ? switchedAt : 0);
  return serverRunning === true && Date.now() - baseline < WAITING_GRACE_MS
    ? "workshop-waiting"
    : "workshop-not-loaded";
}

async function statusFromContext(ctx) {
  const { server, release, method, access, effectiveWorkshopId, live, serverRunning } = ctx;
  const restartedSinceSwitch = computeRestartedSinceSwitch(
    ctx.switchRecord,
    serverRunning,
    ctx.gameStartedAtMs,
    live,
    server.isRemote === true,
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
          // As the game reads them (bridgeIni.hasBridgeEntries): the last
          // line of a duplicated key, `Mods =` ignored, a `\`-prefixed
          // WorkshopItems id not counted.
          iniEntries:
            ctx.iniText !== null ? hasBridgeEntries(ctx.iniText, BRIDGE_MOD_ID, effectiveWorkshopId) : null,
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
  // Local with the check on refuses players because of the loose copy. When
  // the settings make the game load the mod copy instead and no loose Lua is
  // left beside it (reconcile moves it out at every panel launch), players
  // get in: telling the operator to turn the check off would only weaken it.
  const playersBlocked =
    method === "local" &&
    current === true &&
    !(workshopCopyWithChecksumOn(ctx.iniText) && !disk.looseFiles.some(isLooseLua));

  // Steam's public details API (the Mods update check asks it) answering
  // anything but "found" for the item. Only a Workshop server that hasn't
  // confirmed the item cares: the API says "not found" (result 9) for an
  // item Steam's content check still holds back -- a new or updated one
  // -- while dedicated servers download it fine (42.21 live test: result 9
  // before and after a 2.4 s anonymous download and a confirmed start). How
  // strongly the page words it is the client's (getSteamListingNotice):
  // "won't start" only next to a start that failed on the item itself.
  const modChecker = ctx.deps?.modChecker;
  let steamReportsUnavailable = false;
  if (method === "workshop" && state !== "workshop-confirmed" && effectiveWorkshopId) {
    try {
      steamReportsUnavailable = modChecker?.lastUnavailableWorkshopIds?.has?.(effectiveWorkshopId) === true;
    } catch {
      steamReportsUnavailable = false;
    }
  }
  // A Workshop server that runs (or, from its launch, will run) the game
  // without Steam, so the item never downloads. Nothing else reports it --
  // the game starts normally, just without PanelBridge. What its latest
  // start since the switch logged decides ("SteamUtils started without
  // Steam" / "... initialised successfully"): the launch as read from disk
  // (launchSkipsSteam()) only when there is no such line, since a script can
  // set the flag in a way that read can't see. A run still going from
  // before the switch keeps writing its console past the switch time, and
  // says nothing about how the next start comes up: not read then.
  let steamModeOff = false;
  if (method === "workshop" && state !== "workshop-confirmed") {
    const steamStartup =
      access === "automatic" && !(serverRunning === true && restartedSinceSwitch === false)
        ? scanSteamStartup(server.zomboidDataPath, { notBefore: ctx.switchRecord?.at ?? null })
        : null;
    steamModeOff = steamStartup ? !steamStartup.steam : launchSkipsSteam(server);
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
    steamModeOff,
    modAutoRestart: modChecker?.autoRestartEnabled === true,
    bundledVersion: getBundledBridgeVersion(),
    checksum: {
      current,
      canTurnOn: turnOnBlockers.length === 0,
      turnOnBlockers,
      playersBlocked,
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
  const recordServers = recordMembers(ctx).map(displayName);
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
      // No id means the plan is blocked (notPublished / idInvalid); a step
      // with no value would only render as "Add null".
      if (!present.workshopItems && ctx.effectiveWorkshopId) {
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
      // Exactly what removeBridgeEntries() will take out, from every line.
      if (listsIniEntry(text, "Mods", BRIDGE_MOD_ID)) {
        steps.push({ kind: "iniRemove", key: "Mods", value: BRIDGE_MOD_ID, file: iniPath, serverName });
      }
      for (const id of ids) {
        if (listsIniEntry(text, "WorkshopItems", id)) {
          steps.push({ kind: "iniRemove", key: "WorkshopItems", value: id, file: iniPath, serverName });
        }
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
//
// The lock is released after each edit, and the Mods page (mods.js) writes
// through the same per-file lock without taking the lifecycle lock the
// apply route holds. So by the time a later step fails, someone else may
// have saved the file; putting back the bytes read before this edit would
// silently discard their change. The undo therefore restores only while
// the file still holds exactly what this edit wrote, and otherwise leaves
// it alone and fails -- the apply then reports restored:false, and the
// backup taken before the edit is still there.
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
    // Still inside the lock: exactly the bytes this edit left (the backup
    // helper keeps the file's own line ending, so not simply `next`).
    let written = null;
    try {
      written = fs.readFileSync(iniPath);
    } catch {
      written = null;
    }
    undo.push(async () => {
      await withFileLock(iniPath, async () => {
        let current = null;
        try {
          current = fs.readFileSync(iniPath);
        } catch {
          current = null;
        }
        if (written && current && !current.equals(written)) {
          throw new Error(`${path.basename(iniPath)} changed after the switch edited it; left as it is`);
        }
        await writeFileAtomic(iniPath, original.raw);
      });
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
 * lock (waiting at most `lockWaitMs` for it, then a 409 with nothing
 * touched), refuses if the method moved since the preview (expectedFrom) or
 * the switch is blocked, runs every file step, and only then records the new
 * method on the profile(s). Any failure runs the registered undo steps in
 * reverse and throws a DeliveryError whose `restored` says whether every
 * rollback step succeeded (I6).
 */
export async function applyDeliverySwitch(
  server,
  to,
  { expectedFrom, actor = null, deps = {}, lockWaitMs = APPLY_LOCK_WAIT_MS } = {},
) {
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
            // The archive puts back the files it had already moved before
            // rethrowing; `restored: false` means that put-back failed too,
            // which no undo step registered here can repair.
            throw new DeliveryError(
              ErrorCode.PANELBRIDGE_DELIVERY_FILE_ARCHIVE_FAILED,
              500,
              `Couldn't move ${error.fileName || "a PanelBridge file"} out of the game folder. Check its permissions and try again. The panel put back what it had already changed.`,
              { fileName: error.fileName || null },
              error.restored !== false,
            );
          }
          undo.push(() => restoreArchivedBridgeFiles(archived));
        }
      } else if (ctx.access === "automatic" && to === "local") {
        // I4: the loose file is installed and verified first; only then do
        // the entries go, in one write per ini that also turns the Lua
        // integrity check off (with the loose copy, players can't join
        // while it's on).
        const installFailed = () =>
          new DeliveryError(
            ErrorCode.PANELBRIDGE_DELIVERY_INSTALL_FAILED,
            500,
            "Couldn't copy PanelBridge.lua into the game folder. Nothing was changed.",
          );
        const targetPath = resolveTargetPath(ctx.server);
        let previousBytes = null;
        let previousMeta = null;
        try {
          previousBytes = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
          if (previousBytes) previousMeta = readBridgeFileMeta(targetPath);
        } catch (error) {
          // Without the old bytes a failure later on couldn't be undone, so
          // stop before touching anything.
          log.warn(`Could not read ${targetPath} before the switch to panel-installed: ${error.message}`);
          throw installFailed();
        }
        // Registered BEFORE the install: installBridge() can write the file
        // and still fail its read-back check, and that file must not stay in
        // a folder whose method is still Workshop. Compares first, so a
        // no-op install (the file was already current) is left alone.
        undo.push(async () => {
          let currentBytes = null;
          if (fs.existsSync(targetPath)) currentBytes = fs.readFileSync(targetPath);
          if (previousBytes) {
            if (!currentBytes || !currentBytes.equals(previousBytes)) {
              restoreBridgeFileBytes(targetPath, previousBytes, previousMeta);
            }
          } else if (currentBytes) {
            await archiveLooseBridgeFiles(
              ctx.installDir,
              [{ path: targetPath, kind: "server", recognized: true }],
              { reason: "switch-to-local-rollback" },
            );
          }
        });
        const installed = installBridge(ctx.server);
        if (!installed.success || !checkBridgeInstalled(ctx.server).installed) {
          log.warn(`PanelBridge install during switch to panel-installed failed: ${installed.error || "not found after install"}`);
          throw installFailed();
        }
        const ids = knownWorkshopIds(id, ctx.group);
        for (const { iniPath } of iniTargets) {
          await editIni(
            iniPath,
            (text) => setChecksumFalse(removeBridgeEntries(text, BRIDGE_MOD_ID, ids)),
            // Nothing left for the removal to take out, the game reads
            // neither entry (a line only it sees would still name the mod),
            // and it reads the check as off.
            (text) => {
              const mods = readGameIniList(text, "Mods").entries;
              const items = readGameIniList(text, "WorkshopItems").entries;
              return (
                !listsIniEntry(text, "Mods", BRIDGE_MOD_ID) &&
                !ids.some((entry) => listsIniEntry(text, "WorkshopItems", entry)) &&
                !mods.includes(BRIDGE_MOD_ID) &&
                !ids.some((entry) => items.includes(entry)) &&
                !getEffectiveChecksum(text)
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
      // The heartbeat read above is this server's own bridge (the route only
      // switches the active server). A sibling's later heartbeat comes from
      // a different run, so comparing it with this value would call a
      // sibling that never restarted "restarted"; its record carries no
      // baseline and computeRestartedSinceSwitch() falls back to the switch
      // time instead.
      const siblingRecord = { ...record, bridgeStartedAt: null };
      const members = recordMembers(ctx);
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
        await updateServer(member.id, {
          bridgeDelivery: to,
          bridgeDeliverySwitch: sameServer(member, ctx.server) ? record : siblingRecord,
        });
      }
      await commitNow();
    } catch (error) {
      const restored = await runUndo(undo);
      if (error instanceof DeliveryError) {
        // Both halves have to hold: the failing step's own clean-up (an
        // archive that couldn't put its files back) and every undo here.
        error.restored = error.restored !== false && restored;
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
  }, { waitMs: lockWaitMs });
}

function removeStaleTempFiles(installDir, actions) {
  const serverDir = path.join(installDir, "media", "lua", "server");
  let names = [];
  try {
    // codeql[js/path-injection] serverDir is <installDir>/media/lua/server, installDir being resolveInstallDir(server): the profile's own game folder (serverPath/installPath), an operator setting accepted only by the servers.manage / server.install routes (/install and /quick-setup's isValidPath: absolute, no "..") and the folder the panel installs into and launches from by design.
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
      // codeql[js/path-injection] serverDir is <installDir>/media/lua/server of the profile's own operator-configured game folder (resolveInstallDir; /install and /quick-setup's isValidPath: absolute, no ".."), and name is one of serverDir's own readdir entries that matched /^\.PanelBridge\.lua\.tmp\.(\d+)$/ above, so this unlink cannot leave serverDir or touch anything but the panel's own temp files.
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
      // §6.7: a duplicated Mods=/WorkshopItems= key blocks automatic writes.
      // The entries would land on the first line while the game applies the
      // last one, so the write would "succeed" and change nothing the game
      // reads. The operator fixes the file (Server Config › INI, raw); the
      // game's own re-save at startup also collapses the duplicates.
      if (hasDuplicateListKeys(text)) {
        log.warn(`${iniPath} lists Mods= or WorkshopItems= more than once; not adding PanelBridge's entries to it`);
        warnings.push("iniWriteFailed");
        return;
      }
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
      if (next === text) {
        // Nothing to write, but the writers read the file more loosely than
        // the game does: a value the game cuts short (`Mods=A=B;…`) or a
        // line only the game sees still leaves the bridge unloaded.
        const present = hasBridgeEntries(text, BRIDGE_MOD_ID, id);
        if (!present.mods || !present.workshopItems) {
          log.warn(`${iniPath} lists PanelBridge's entries in a form the game doesn't read; fix it in Server Config › INI (raw)`);
          warnings.push("iniWriteFailed");
        }
        return;
      }
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
  // codeql[js/path-injection] installDir is resolveInstallDir(server): the profile's own game folder (serverPath/installPath), an operator setting accepted only by the servers.manage / server.install routes (/install and /quick-setup's isValidPath: absolute, no "..") and the folder the panel installs into and launches from by design -- this is only an existence check.
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

    const ownIniPath = method === "local" ? resolveBridgeIniPath(fresh) : null;
    if (method === "local" && workshopCopyWithChecksumOn(ownIniPath ? readIniTextSafe(ownIniPath) : null)) {
      // This server's own settings load the bridge's mod copy with the Lua
      // integrity check on: a loose copy beside it would get every
      // non-admin join refused (see workshopCopyWithChecksumOn), and would
      // turn a joinable server unjoinable at the very launch meant to keep
      // it right. So none is installed or kept -- the mod copy loads anyway,
      // and if it can't download, the start aborts with or without one. The
      // settings file is left alone: whether to make the Workshop official
      // or to switch back (which removes the entries and turns the check
      // off) is the operator's choice, and GET /delivery offers both
      // (local-workshop-loaded).
      warnings.push("workshopEntriesWithChecksum");
      log.warn(
        `${ownIniPath} loads PanelBridge from the Steam Workshop (Mods= lists ${BRIDGE_MOD_ID}) with DoLuaChecksum on, ` +
          `but ${displayName(fresh) || installDir} is set to panel-installed: not installing the loose PanelBridge.lua ` +
          "beside it. Choose Steam Workshop or panel-installed in Settings › PanelBridge.",
      );
      const loose = listLooseBridgeFiles(installDir).filter(isLooseLua);
      if (loose.length > 0) {
        try {
          const archived = await archiveLooseBridgeFiles(installDir, loose, { reason: `workshop-entries-${reason}` });
          for (const moved of archived.moved) actions.push({ kind: "archived", path: moved });
        } catch (error) {
          log.warn(`Could not move loose PanelBridge files out of ${installDir}: ${error.message}`);
          warnings.push("archiveFailed");
        }
      }
    } else if (method === "local") {
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
      const loose = listLooseBridgeFiles(installDir).filter(isLooseLua);
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
      else {
        if (launchSkipsSteam(fresh)) {
          log.warn(
            `${displayName(fresh) || installDir} gets PanelBridge from the Steam Workshop, but its launch runs ` +
              "zombie.network.GameServer without -Dzomboid.steam=1: the game then runs without Steam and never " +
              "downloads the item. Add -Dzomboid.steam=1 to the java command line.",
          );
        }
        await reconcileWorkshopIni(fresh, id, actions, warnings);
      }
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
