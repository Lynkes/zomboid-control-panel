// Protected areas and world state for Server Files (spec §A5).
//
// This is the ONLY file-manager module that names the bridge's files, and it
// makes no write calls at all: it only answers "is this path protected, and
// how?" for the service, which enforces the answer. That keeps
// bridgeSingleWriterGate.test.js meaningful (a write call near a bridge file
// name anywhere else is flagged).
//
// Everything is matched on the REAL path relative to the root (after links),
// lower-cased on every OS (a case-insensitive mount can sit under a Linux
// panel), plus (dev, ino) for the panel's own secret files, which defeats
// hard links, 8.3 short names, case aliases and bind-mount aliases alike.
// CASE_FOLD below is only for absolute-path containment, which must follow
// the host filesystem exactly.
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
 * Anchors that belong to another folder (a profile's Zomboid data folder,
 * its game install folder, its launch folder) are placed by their absolute
 * real path, so they hold whichever root reaches them: -cachedir can put the
 * Zomboid folder inside the game folder, and one profile's install folder
 * can hold another profile's data.
 *
 * @param {object} opts
 * @param {"install"|"launch"|"data"|"config"} opts.rootId
 * @param {string} opts.rootReal  the root's realpath
 * @param {object[]} opts.profiles  every local profile (each contributes its
 *   World Backups, bridge folder, world saves, bridge files and launch
 *   scripts wherever they fall inside this root)
 * @param {object} opts.settings  panel settings (https key/cert paths)
 * @param {string|null} [opts.bridgePath]  the live PanelBridge folder, if any
 */
export function buildProtectionContext({ rootId, rootReal, profiles = [], settings = {}, bridgePath = null }) {
  const { dataDir, logsDir, configPath } = getDataPaths();
  // Every anchor is stored and compared lower-cased, whatever the host OS:
  // a Linux panel can sit on a case-insensitive mount (Docker Desktop on
  // Windows or macOS), where realpath keeps the case as typed. On a
  // case-sensitive filesystem that only ever protects a little more.
  /** @type {Array<{ rel: string, area: string, prefix?: boolean }>} */
  const anchors = [];
  let rootSealed = null;
  const pushAnchor = (rel, area, { prefix = false } = {}) => {
    anchors.push({ rel: String(rel).toLowerCase(), area, ...(prefix ? { prefix: true } : {}) });
  };

  // An anchor given as an absolute real path: an area inside this root, or
  // the whole root when the root itself sits inside the area.
  const addAnchor = (absReal, area) => {
    if (!absReal) return;
    if (isInsideAbs(absReal, rootReal)) {
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

  // World Backups at the top of a data root (every profile's own
  // <data>/backups is added below, wherever this root reaches it).
  if (rootId === "data") pushAnchor("backups", "panelBackups");

  // Bridge I/O folders: Lua/panelbridge at the top of any root (deeper ones
  // match the segment rule), plus the live bridge folder wherever it is.
  pushAnchor("Lua/panelbridge", "bridgeIo");
  const liveBridge = tryRealpath(bridgePath);
  if (liveBridge) addAnchor(liveBridge, "bridgeIo");

  // Files the bridge's delivery owns in a game install folder: this root
  // when it is one, and any profile's install folder inside this root.
  const installFolders = new Set();
  if (rootId === "install") installFolders.add(rootReal);
  for (const profile of profiles) {
    const installReal = tryRealpath(launchDirOf({ installPath: profile?.installPath }));
    if (installReal && isInsideAbs(rootReal, installReal)) installFolders.add(installReal);
  }
  const workshopId = getWorkshopRelease()?.workshopId;
  for (const installReal of installFolders) {
    addAnchor(path.join(installReal, "media", "lua", "server", "PanelBridge.lua"), "bridgeManaged");
    addAnchor(path.join(installReal, "media", "lua", "client", "PanelBridgeClient.lua"), "bridgeManaged");
    for (const file of listLooseBridgeFiles(installReal)) {
      if (file.kind !== "rootModInfo") continue;
      addAnchor(path.join(installReal, path.basename(file.path)), "bridgeManaged");
    }
    if (workshopId && /^\d+$/.test(String(workshopId))) {
      addAnchor(path.join(installReal, "steamapps", "workshop", "content", PZ_WORKSHOP_APP_ID, String(workshopId)), "bridgeManaged");
    }
  }

  // Launch scripts the panel regenerates before every start, for every
  // managed profile whose launch folder is this root or inside it. They
  // carry -adminpassword in plain text, so they are list-only, and so are
  // the timestamped copies the panel keeps of a hand-edited one (in any
  // launch mode: only the panel writes those).
  for (const profile of profiles) {
    if (!profile?.serverName) continue;
    const launchReal = tryRealpath(launchDirOf(profile));
    const rel = launchReal ? relFromRoot(rootReal, launchReal) : null;
    if (rel === null) continue;
    const prefix = rel ? `${rel}/` : "";
    const scripts = [managedStartupScriptName(profile.serverName, true), managedStartupScriptName(profile.serverName, false)];
    for (const name of scripts) pushAnchor(`${prefix}${name}.bak-`, "launchScripts", { prefix: true });
    if (resolveLaunchMode(profile).mode !== "managed") continue;
    for (const name of [...scripts, LAUNCH_SCRIPT_MANIFEST]) pushAnchor(`${prefix}${name}`, "launchScripts");
  }

  // Every profile's Zomboid data folder, wherever this root reaches it: its
  // World Backups, its bridge folder (for the ancestor rule), and its world
  // saves (gated by that profile's live state).
  const worldAreas = [];
  for (const profile of profiles) {
    const dataReal = tryRealpath(profile?.zomboidDataPath);
    if (!dataReal) continue;
    if (!isInsideAbs(rootReal, dataReal) && !isInsideAbs(dataReal, rootReal)) continue;
    addAnchor(path.join(dataReal, "backups"), "panelBackups");
    addAnchor(path.join(dataReal, "Lua", "panelbridge"), "bridgeIo");
    for (const area of worldAreasFor(profile)) {
      const abs = path.join(dataReal, ...area.rel.split("/"));
      let rel = relFromRoot(rootReal, abs);
      if (rel === null && isInsideAbs(abs, rootReal)) rel = "";
      if (rel !== null) worldAreas.push({ rel: rel.toLowerCase(), owner: area.owner });
    }
  }

  return makeRules({ anchors, secretInodes: secrets.inodes, worldAreas, rootSealed });
}

// The rule set both builders return: classify(), protectedWithin(),
// worldStateOwners() and isWorldState() over one list of anchors. Anchors
// and world areas are lower-case, and every subject is lower-cased to match.
// A `prefix` anchor matches the names in its folder that start with it.
function makeRules({ anchors, secretInodes, worldAreas, rootSealed }) {
  const lowerOf = (rel) => String(rel).toLowerCase();
  const matches = (anchor, subject) =>
    anchor.prefix
      ? subject.startsWith(anchor.rel) && !subject.slice(anchor.rel.length).includes("/")
      : relWithin(anchor.rel, subject);

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
    const lower = lowerOf(realRel);
    for (const anchor of anchors) {
      if (matches(anchor, lower)) result = stricter(result, protection(anchor.area));
    }
    if (lower) {
      const segments = lower.split("/");
      for (let i = 0; i < segments.length; i++) {
        if (CREDENTIAL_DIRS.has(segments[i])) result = stricter(result, protection("credentials"));
        if (i + 1 < segments.length && segments[i] === "lua" && segments[i + 1] === "panelbridge") {
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
    const lower = lowerOf(realRel);
    let result = null;
    for (const anchor of anchors) {
      if (anchor.rel !== lower && relWithin(lower, anchor.rel)) {
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
    const lower = lowerOf(realRel);
    const owners = [];
    for (const area of worldAreas) {
      if (relWithin(area.rel, lower) || relWithin(lower, area.rel)) {
        if (!owners.includes(area.owner)) owners.push(area.owner);
      }
    }
    return owners;
  }

  /** True when `realRel` is inside (not merely an ancestor of) a world save. */
  function isWorldState(realRel) {
    const lower = lowerOf(realRel);
    return worldAreas.some((area) => relWithin(area.rel, lower));
  }

  return { classify, protectedWithin, worldStateOwners, isWorldState, anchors, rootSealed };
}

// A profile's world save areas, relative to its Zomboid data folder.
function worldAreasFor(profile) {
  const name = profile?.serverName;
  if (!name || typeof name !== "string") return [];
  return [
    `Saves/Multiplayer/${name}`,
    `Saves/Multiplayer/${name}_player`,
    `db/${name}.db`,
    `db/${name}.db-journal`,
    `db/${name}.db-wal`,
    `db/${name}.db-shm`,
  ].map((rel) => ({ rel, owner: profile }));
}

/**
 * The same rules for a root on the active remote server (spec §A12): the
 * bridge's command folder and its managed files, and the world saves of the
 * profile. There are no panel secrets on the remote host. Remote paths are
 * POSIX; they are compared lower-cased like local ones, since an SFTP server
 * can sit on a case-insensitive filesystem too.
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
    anchors.push({ rel: String(rel).toLowerCase(), area });
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
    if (workshopId && /^\d+$/.test(String(workshopId))) {
      pushAnchor(`steamapps/workshop/content/${PZ_WORKSHOP_APP_ID}/${workshopId}`, "bridgeManaged");
    }
  }
  const worldAreas =
    rootId === "data" ? worldAreasFor(profile).map((area) => ({ rel: area.rel.toLowerCase(), owner: area.owner })) : [];
  return makeRules({ anchors, secretInodes: new Set(), worldAreas, rootSealed });
}
