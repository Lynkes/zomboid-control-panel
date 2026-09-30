// Protected areas and world state for Server Files (spec §A5).
//
// This is the ONLY file-manager module that names the bridge's files, and it
// makes no write calls at all: it only answers "is this path protected, and
// how?" for the service, which enforces the answer. That keeps
// bridgeSingleWriterGate.test.js meaningful (a write call near a bridge file
// name anywhere else is flagged).
//
// Everything is matched on the REAL path relative to the root (after links),
// case-folded where the filesystem is case-insensitive, plus (dev, ino) for
// the panel's own secret files, which defeats hard links, 8.3 short names,
// case aliases and bind-mount aliases alike.
import path from "path";
import { getDataPaths, getPanelProgramDir } from "../utils/paths.js";
import { listLooseBridgeFiles } from "./bridgeDisk.js";
import { getWorkshopRelease } from "./bridgeWorkshopRelease.js";
import { resolveLaunchMode, managedStartupScriptName } from "./serverManager.js";
import { PROTECTED_AREA_LEVEL } from "./fileManagerContract.js";
import { realpathNative, statBig } from "./fileManagerLocalFs.js";

export const CASE_FOLD = process.platform === "win32" || process.platform === "darwin";

const LEVEL_RANK = { readOnly: 1, listOnly: 2, sealed: 3 };
const CREDENTIAL_DIRS = new Set([".ssh", ".gnupg", ".steam"]);
const MAX_ENV_SECRET_FILES = 8;
const PZ_WORKSHOP_APP_ID = "108600";
const LAUNCH_SCRIPT_MANIFEST = ".pz-panel-scripts.json";

export function foldRel(rel) {
  return CASE_FOLD ? String(rel).toLowerCase() : String(rel);
}

/** True when `rel` is `anchor` or inside it (POSIX root-relative paths; "" is the root). */
export function relWithin(anchor, rel) {
  if (anchor === "") return true;
  return rel === anchor || rel.startsWith(`${anchor}/`);
}

/** Absolute-path containment on real paths, case-folded where the OS is. */
export function isInsideAbs(parent, child) {
  const a = CASE_FOLD ? parent.toLowerCase() : parent;
  const b = CASE_FOLD ? child.toLowerCase() : child;
  const rel = path.relative(a, b);
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

/** Root-relative POSIX path of an absolute real path, or null when outside. */
export function relFromRoot(rootReal, abs) {
  if (!abs || !isInsideAbs(rootReal, abs)) return null;
  const rel = path.relative(rootReal, abs);
  return rel.split(path.sep).join("/");
}

export function stricter(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;
}

function protection(area) {
  return { level: PROTECTED_AREA_LEVEL[area], area };
}

function tryRealpath(p) {
  if (!p || typeof p !== "string" || !path.isAbsolute(p)) return null;
  try {
    return realpathNative(p);
  } catch {
    return null;
  }
}

function inodeKey(stat) {
  if (!stat || stat.dev === null || stat.dev === undefined || stat.ino === null || stat.ino === undefined) return null;
  const ino = BigInt(stat.ino);
  // Some filesystems report 0 for every file; an inode of 0 identifies nothing.
  if (ino === 0n) return null;
  return `${BigInt(stat.dev)}:${ino}`;
}

// The launch folder a managed profile writes its scripts into: serverPath
// || installPath, with a launcher file name stripped to its folder.
export function launchDirOf(profile) {
  const raw = profile?.serverPath || profile?.installPath;
  if (!raw || typeof raw !== "string") return null;
  return /\.(bat|sh|exe)$/i.test(raw) ? path.dirname(raw) : raw;
}

// The panel's own secret files, identified by (dev, ino). Built per request
// with at most about a dozen stat calls.
function buildSecretSet(settings) {
  const { dataDir } = getDataPaths();
  const candidates = [
    settings?.httpsKeyPath,
    settings?.httpsCertPath,
    path.join(dataDir, "jwt.secret"),
    path.join(dataDir, "db.json"),
  ];
  let envCount = 0;
  for (const [name, value] of Object.entries(process.env)) {
    if (envCount >= MAX_ENV_SECRET_FILES) break;
    if (!name.endsWith("_FILE") || typeof value !== "string" || !path.isAbsolute(value)) continue;
    candidates.push(value);
    envCount++;
  }
  const inodes = new Set();
  const reals = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    try {
      const st = statBig(candidate);
      const key = inodeKey(st);
      if (key) inodes.add(key);
      const real = tryRealpath(candidate);
      if (real) reals.push(real);
    } catch {
      /* missing: nothing to protect */
    }
  }
  return { inodes, reals };
}

/**
 * Build the protection rules for one root, once per request.
 *
 * @param {object} opts
 * @param {"install"|"launch"|"data"|"config"} opts.rootId
 * @param {string} opts.rootReal  the root's realpath
 * @param {object[]} opts.profiles  every local profile (the ones that share this
 *   root's folder contribute their launch scripts and world saves)
 * @param {object} opts.settings  panel settings (https key/cert paths)
 * @param {string|null} [opts.bridgePath]  the live PanelBridge folder, if any
 */
export function buildProtectionContext({ rootId, rootReal, profiles = [], settings = {}, bridgePath = null }) {
  const { dataDir, logsDir, configPath } = getDataPaths();
  // Each anchor's rel is stored the way it is compared: lower-cased for the
  // bridge's own areas (the game lower-cases Lua paths when it loads them,
  // so any case is the same file to it), case-folded like the filesystem
  // otherwise.
  /** @type {Array<{ rel: string, area: string, ci: boolean }>} */
  const anchors = [];
  let rootSealed = null;
  const isCi = (area) => area === "bridgeIo" || area === "bridgeManaged";
  const pushAnchor = (rel, area) => {
    anchors.push({ rel: isCi(area) ? String(rel).toLowerCase() : foldRel(rel), area, ci: isCi(area) });
  };

  const addAnchor = (absReal, area) => {
    if (!absReal) return;
    if (isInsideAbs(absReal, rootReal)) {
      // The root itself sits inside a panel area: everything is protected.
      rootSealed = stricter(rootSealed, protection(area));
      return;
    }
    const rel = relFromRoot(rootReal, absReal);
    if (rel !== null) pushAnchor(rel, area);
  };

  addAnchor(tryRealpath(dataDir), "panelData");
  addAnchor(tryRealpath(logsDir), "panelLogs");
  addAnchor(tryRealpath(getPanelProgramDir()), "panelProgram");
  addAnchor(tryRealpath(configPath), "panelProgram");

  const secrets = buildSecretSet(settings);
  for (const real of secrets.reals) {
    const rel = relFromRoot(rootReal, real);
    if (rel !== null && rel !== "") pushAnchor(rel, "panelSecret");
  }

  // Credentials at the top of a root (a root set to a service account's
  // home); deeper ones are caught by the segment rule in classify().
  for (const name of CREDENTIAL_DIRS) pushAnchor(name, "credentials");

  if (rootId === "data") pushAnchor("backups", "panelBackups");

  // Bridge I/O folders: Lua/panelbridge at the top of any root (deeper ones
  // match the segment rule), plus the live bridge folder wherever it is.
  pushAnchor("Lua/panelbridge", "bridgeIo");
  const liveBridge = tryRealpath(bridgePath);
  if (liveBridge) addAnchor(liveBridge, "bridgeIo");

  // Files the bridge's delivery owns in the game install folder.
  if (rootId === "install") {
    pushAnchor("media/lua/server/PanelBridge.lua", "bridgeManaged");
    pushAnchor("media/lua/client/PanelBridgeClient.lua", "bridgeManaged");
    for (const file of listLooseBridgeFiles(rootReal)) {
      if (file.kind !== "rootModInfo") continue;
      pushAnchor(path.basename(file.path), "bridgeManaged");
    }
    const workshopId = getWorkshopRelease()?.workshopId;
    if (workshopId && /^\d+$/.test(String(workshopId))) {
      pushAnchor(`steamapps/workshop/content/${PZ_WORKSHOP_APP_ID}/${workshopId}`, "bridgeManaged");
    }
  }

  // Launch scripts the panel regenerates before every start, for every
  // managed profile whose launch folder is this root or inside it.
  for (const profile of profiles) {
    if (!profile?.serverName || resolveLaunchMode(profile).mode !== "managed") continue;
    const launchReal = tryRealpath(launchDirOf(profile));
    const rel = launchReal ? relFromRoot(rootReal, launchReal) : null;
    if (rel === null) continue;
    const prefix = rel ? `${rel}/` : "";
    for (const name of [
      managedStartupScriptName(profile.serverName, true),
      managedStartupScriptName(profile.serverName, false),
      LAUNCH_SCRIPT_MANIFEST,
    ]) {
      pushAnchor(`${prefix}${name}`, "launchScripts");
    }
  }

  // World saves: every profile whose data folder is this root.
  const worldAreas = [];
  if (rootId === "data") {
    for (const profile of profiles) {
      const name = profile?.serverName;
      if (!name || typeof name !== "string") continue;
      const dataReal = tryRealpath(profile.zomboidDataPath);
      if (!dataReal || !isInsideAbs(dataReal, rootReal) || !isInsideAbs(rootReal, dataReal)) continue;
      worldAreas.push(...worldAreasFor(profile, foldRel));
    }
  }

  return makeRules({ anchors, secretInodes: secrets.inodes, worldAreas, rootSealed, fold: CASE_FOLD });
}

// The rule set both builders return: classify(), protectedWithin(),
// worldStateOwners() and isWorldState() over one list of anchors.
function makeRules({ anchors, secretInodes, worldAreas, rootSealed, fold }) {
  const foldIt = (rel) => (fold ? String(rel).toLowerCase() : String(rel));

  /**
   * @param {string} realRel  root-relative real path
   * @param {{ dev?: bigint|null, ino?: bigint|null, type?: string }|null} [stat]
   * @returns {{ level: string, area: string }|null}
   */
  function classify(realRel, stat = null) {
    let result = rootSealed;
    if (stat && secretInodes.size && (stat.type === "file" || stat.type === undefined)) {
      const key = inodeKey(stat);
      if (key && secretInodes.has(key)) result = stricter(result, protection("panelSecret"));
    }
    const folded = foldIt(realRel);
    const lower = String(realRel).toLowerCase();
    for (const anchor of anchors) {
      const subject = anchor.ci ? lower : folded;
      if (relWithin(anchor.rel, subject)) result = stricter(result, protection(anchor.area));
    }
    if (realRel) {
      const segments = String(realRel).split("/");
      for (let i = 0; i < segments.length; i++) {
        const seg = fold ? segments[i].toLowerCase() : segments[i];
        if (CREDENTIAL_DIRS.has(seg)) result = stricter(result, protection("credentials"));
        if (
          i + 1 < segments.length &&
          segments[i].toLowerCase() === "lua" &&
          segments[i + 1].toLowerCase() === "panelbridge"
        ) {
          result = stricter(result, protection("bridgeIo"));
        }
      }
    }
    return result ? { level: result.level, area: result.area } : null;
  }

  /**
   * The strictest protected anchor strictly inside `realRel` (the ancestor
   * rule: a folder holding something protected can't be renamed, moved or
   * deleted as a whole).
   */
  function protectedWithin(realRel) {
    const folded = foldIt(realRel);
    const lower = String(realRel).toLowerCase();
    let result = null;
    for (const anchor of anchors) {
      const subject = anchor.ci ? lower : folded;
      if (anchor.rel !== subject && relWithin(subject, anchor.rel)) {
        result = stricter(result, protection(anchor.area));
      }
    }
    return result ? { level: result.level, area: result.area, containsProtected: true } : null;
  }

  /**
   * Profiles whose world save `realRel` is inside of, or holds (an ancestor
   * such as Saves/ or db/). Empty when it touches no world save.
   */
  function worldStateOwners(realRel) {
    const folded = foldIt(realRel);
    const owners = [];
    for (const area of worldAreas) {
      if (relWithin(area.rel, folded) || relWithin(folded, area.rel)) {
        if (!owners.includes(area.owner)) owners.push(area.owner);
      }
    }
    return owners;
  }

  /** True when `realRel` is inside (not merely an ancestor of) a world save. */
  function isWorldState(realRel) {
    const folded = foldIt(realRel);
    return worldAreas.some((area) => relWithin(area.rel, folded));
  }

  return { classify, protectedWithin, worldStateOwners, isWorldState, anchors, rootSealed };
}

function worldAreasFor(profile, foldIt) {
  const name = profile?.serverName;
  if (!name || typeof name !== "string") return [];
  return [
    `Saves/Multiplayer/${name}`,
    `Saves/Multiplayer/${name}_player`,
    `db/${name}.db`,
    `db/${name}.db-journal`,
    `db/${name}.db-wal`,
    `db/${name}.db-shm`,
  ].map((rel) => ({ rel: foldIt(rel), owner: profile }));
}

/**
 * The same rules for a root on the active remote server (spec §A12): the
 * bridge's command folder and its managed files, and the world saves of the
 * profile. There are no panel secrets on the remote host. Remote paths are
 * POSIX and case-sensitive.
 *
 * @param {object} opts
 * @param {"install"|"launch"|"data"|"config"} opts.rootId
 * @param {string} opts.rootReal  the root's remote real path
 * @param {object} opts.profile
 * @param {object} opts.settings
 */
export function buildRemoteProtectionContext({ rootId, rootReal, profile, settings = {} }) {
  const anchors = [];
  const pushAnchor = (rel, area) => {
    const ci = area === "bridgeIo" || area === "bridgeManaged";
    anchors.push({ rel: ci ? String(rel).toLowerCase() : String(rel), area, ci });
  };
  const posixRel = (abs) => {
    if (typeof abs !== "string" || !abs.startsWith("/") || typeof rootReal !== "string") return null;
    const rel = path.posix.relative(rootReal, path.posix.normalize(abs));
    if (rel === "" || rel.startsWith("..") || path.posix.isAbsolute(rel)) return rel === "" ? "" : null;
    return rel;
  };
  let rootSealed = null;
  pushAnchor("Lua/panelbridge", "bridgeIo");
  const bridgeRel = posixRel(settings.panelBridgeSftpBridgePath);
  if (bridgeRel === "") rootSealed = protection("bridgeIo");
  else if (bridgeRel) pushAnchor(bridgeRel, "bridgeIo");
  if (rootId === "install") {
    pushAnchor("media/lua/server/PanelBridge.lua", "bridgeManaged");
    pushAnchor("media/lua/client/PanelBridgeClient.lua", "bridgeManaged");
    const workshopId = getWorkshopRelease()?.workshopId;
    if (workshopId && /^d+$/.test(String(workshopId))) {
      pushAnchor(`steamapps/workshop/content/${PZ_WORKSHOP_APP_ID}/${workshopId}`, "bridgeManaged");
    }
  }
  const worldAreas = rootId === "data" ? worldAreasFor(profile, (rel) => rel) : [];
  return makeRules({ anchors, secretInodes: new Set(), worldAreas, rootSealed, fold: false });
}
