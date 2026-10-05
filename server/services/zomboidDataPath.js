import fs from "fs";
import path from "path";
import { ErrorCode } from "../utils/errorCodes.js";
import { inspectZomboidPath, looksLikeSaveDir, normalizeUserPath } from "../utils/zomboidPaths.js";

// SECURITY (2026-10-05, PATHS-1): a server's Zomboid data folder (its
// zomboidDataPath, the game's -cachedir) is the folder chunks /browse lists
// every folder name under, Server Files reaches Server/ in, backups read
// Saves/ from and write backups/ into, and wipe deletes from. POST
// /api/servers saved it with no check at all, so servers.manage alone
// (technician) could name any folder on this computer as one. Every place
// that sets it -- POST and PUT /api/servers, /install and /quick-setup,
// create-from-discovery, chunks /save-path, and the legacy setting in PUT
// /config/app-settings -- now holds it to this one rule, and the features
// that list or read under it apply the rule again when they use it (a
// folder that didn't exist when it was saved can appear later):
//   - an absolute path, at most 1024 characters, no control characters;
//   - and nothing there yet (the game creates the folder on first start),
//     or a folder that already is one: a Saves or Multiplayer folder or
//     save files directly in it (inspectZomboidPath()'s on-disk checks --
//     not its name-only ones, which any folder whose path says "zomboid" or
//     "saves" passes, the panel's own folder included), or nothing in it
//     but what the game itself puts in a data folder (empty included), or
//     nothing in it but world saves (a Saves/Multiplayer folder named
//     directly, as Map Cleanup allows).
// A server install folder is refused. The folder PZ_SAVE_PATH names comes
// from the operator's own environment (the Docker images set it), not from
// a request, and is taken as it is. Remote servers stay exempt at the
// setters: their paths are on another host. So a remote record's data
// folder is no folder of this computer's, and the features that use one
// here either apply zomboidDataFolderHolds() to it or don't use a remote
// server's at all. Applying it: chunks /browse, Server Files' image browser,
// the log tailer, and every reader and writer of the server's config folder
// (mods, /configure-rcon, /configure-network, the UPnP edit,
// ensureRconConfigured, templates, PanelBridge delivery, pre-restart config
// backups, backup snapshots, the Discord presence, the support bundle),
// through utils/serverConfigPath.js. Not using a remote server's: backups,
// the console-log routes, wipe. The legacy settings copy
// (setActiveServer()) takes no remote server's folders, and the features
// that fall back to it apply the rule to it as well (PATHS-1 verifier
// pass 2).
const ZOMBOID_DATA_PATH_MAX_LENGTH = 1024;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

// What the game puts in its data folder, read off the B42 projectzomboid.jar
// (the arguments ZomboidFileSystem.getCacheDirSub() is called with, and the
// getCacheDir() + separator + name paths its callers build: GameServer,
// GameWindow, ZipLogs, ZipBackup, DebugLog, LuaManager, InstanceTracker,
// RecipeMonitor, CraftRecipeManager, ...), checked against a real B42
// ~/Zomboid. Matched exactly, as the game names them.
const GAME_DATA_FOLDER_ENTRIES = new Set([
  // Folders
  "Saves",
  "Server",
  "Logs",
  "Lua",
  "db",
  "mods",
  "Workshop",
  "Sandbox Presets",
  "backups",
  "Screenshots",
  "messaging",
  "joypads",
  "InputBindings",
  "Crafting",
  "Recording",
  "RecipeLogs",
  // Files
  "console.txt",
  "server-console.txt",
  "coop-console.txt",
  "options.ini",
  "options2.bin",
  "debug-options.ini",
  "latestSave.ini",
  "logs.zip",
  "version.txt",
  "debuglog.cfg",
  "debuglog-server.cfg",
  "debuglog.ini",
  "sounds.ini",
  "screenresolution.ini",
  "translationProblems.txt",
  "AllRecipes.txt",
  "sound-event-instances.txt",
  "ItemTracker.log",
  "popman-options.ini",
  "isoregions-options.ini",
  "animationViewerState-options.ini",
  "bulletTracerEffect-options.ini",
  "debugChunkState-options.ini",
  "SeamEditorState-options.ini",
  "SpriteModelEditorState-options.ini",
  "TileGeometryState-options.ini",
]);

const GAME_DATA_FOLDER_PATTERNS = [
  /^log_\d+\.txt$/,
  // Java's zip file system (ZipLogs writes logs.zip through it) leaves
  // these next to the zip.
  /^zipfstmp\d+\.tmp$/,
  /^movables_stats_[^\\/]+\.txt$/,
  /^reset-mods-[^\\/]+\.txt$/,
];

// Left by the operating system, not the game: Finder, Explorer, and the
// root of an ext4 volume mounted as the data folder.
const OS_FOLDER_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "lost+found"]);

export function isGameDataFolderEntry(name) {
  return (
    GAME_DATA_FOLDER_ENTRIES.has(name) ||
    OS_FOLDER_ENTRIES.has(name) ||
    GAME_DATA_FOLDER_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function hasPathShape(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ZOMBOID_DATA_PATH_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isOperatorDataPath(resolved) {
  const configured = process.env.PZ_SAVE_PATH;
  if (!configured || !path.isAbsolute(configured)) return false;
  const own = path.resolve(configured);
  return process.platform === "win32"
    ? own.toLowerCase() === resolved.toLowerCase()
    : own === resolved;
}

// The rule's on-disk half, for an absolute, resolved path. Links are
// followed (statSync, readdirSync), so a link is judged by the folder it
// leads to.
function judgeFolder(resolved) {
  if (isOperatorDataPath(resolved)) return { ok: true, missing: false };
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, missing: true };
    return { ok: false, reason: "unreadable" };
  }
  if (!stat.isDirectory()) return { ok: false, reason: "not-a-directory" };
  // The common case first, cheaply: a data folder the game has run in has
  // Saves (inspectZomboidPath() probes every subfolder for save files).
  if (fs.existsSync(path.join(resolved, "Saves")) || fs.existsSync(path.join(resolved, "Multiplayer"))) {
    return { ok: true, missing: false };
  }
  const verdict = inspectZomboidPath(resolved);
  if (verdict.reason === "install-folder") return { ok: false, reason: "install-folder" };
  // Save files directly in the folder (a world save folder), not its
  // hasSaveArtifacts: that one also looks inside every folder just under
  // this one, so any folder holding, say, some-project/map/ passed, whatever
  // else it held (PATHS-1 verifier pass). A real data folder's save files
  // sit under Saves/, which the check above already accepts.
  if (looksLikeSaveDir(resolved)) return { ok: true, missing: false };
  let names;
  try {
    names = fs.readdirSync(resolved);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (names.every(isGameDataFolderEntry)) return { ok: true, missing: false };
  // A Saves/Multiplayer folder named directly, as Map Cleanup's custom path
  // and "Save as default" allow (its hint names this shape, and
  // routes/chunks.js's resolveSavesPath() reads one): named as the game
  // names it, and nothing in it but world saves. Counting save files only
  // directly in the folder (the first PATHS-1 verifier pass) stopped one
  // holding saves from passing, while an empty one still did (verifier
  // pass 2). Both halves count: the name alone is any
  // .../Saves/Multiplayer folder, and "every folder in it has save files"
  // alone is any folder of projects that each have a map/ folder. Judged
  // entry by entry, so one that also holds anything else is still refused.
  return isSavesMultiplayerFolder(resolved) &&
    names.length > 0 &&
    names.every((name) => isMultiplayerFolderEntry(resolved, name))
    ? { ok: true, missing: false }
    : { ok: false, reason: "not-a-data-folder" };
}

// Exactly as the game names them (ZomboidFileSystem.getSaveDir() is
// getCacheDirSub("Saves"), and a multiplayer world goes in its
// Core.gameMode "Multiplayer" folder) and as resolveSavesPath() matches them.
function isSavesMultiplayerFolder(resolved) {
  return path.basename(resolved) === "Multiplayer" && path.basename(path.dirname(resolved)) === "Saves";
}

// What the game keeps in Saves/Multiplayer: one folder per world save --
// a dedicated server's own (named after the server, save files in it), and
// on a machine that also plays, the client's per-server cache, which
// ConnectToServerState names "<id>_<name>_player", the id a Java long the
// server sends (read off the B42 jar). The OS's own entries are let through
// as above.
const MULTIPLAYER_PLAYER_CACHE_FOLDER = /^-?\d+_.+_player$/;

function isMultiplayerFolderEntry(folder, name) {
  if (OS_FOLDER_ENTRIES.has(name)) return true;
  const entry = path.join(folder, name);
  try {
    if (!fs.statSync(entry).isDirectory()) return false;
  } catch {
    return false;
  }
  return MULTIPLAYER_PLAYER_CACHE_FOLDER.test(name) || looksLikeSaveDir(entry);
}

const NOT_A_DATA_FOLDER_MESSAGE =
  "This folder holds files the game doesn't keep in a Zomboid data folder, so it can't be a server's data folder. Choose the server's own data folder (the one with a Saves folder), an empty folder, or a folder that doesn't exist yet: the game creates it when the server first starts.";

/**
 * Save time: judge a data folder a request is about to store.
 *
 * `expand` (default true) applies normalizeUserPath() first (quotes, "~",
 * %VAR%/$VAR), as PUT /api/servers and chunks /save-path always have; the
 * install routes pass false because they use the value exactly as sent.
 * A value that names an environment variable must already exist: stored
 * as an expanded path that isn't there, it would hand the variable's value
 * back to anyone who can read the server's paths (env-var-expansion-oracle,
 * 2026-09-05). Error text only ever echoes the caller's own value.
 *
 * @returns {{ ok: true, path: string } | { ok: false, body: { error: string, code?: string } }}
 */
export function checkZomboidDataPath(value, { expand = true } = {}) {
  const raw = typeof value === "string" ? value : "";
  const target = expand ? normalizeUserPath(raw) : raw;
  if (!hasPathShape(raw) || !hasPathShape(target) || !path.isAbsolute(target)) {
    return {
      ok: false,
      body: {
        error: hasPathShape(raw)
          ? `Invalid Zomboid data path: ${raw}. Use the folder's full path.`
          : "Invalid Zomboid data path",
        code: ErrorCode.ZOMBOID_DATA_PATH_INVALID,
      },
    };
  }
  const resolved = path.resolve(target);
  const verdict = judgeFolder(resolved);
  if (verdict.ok && verdict.missing && expand && target !== normalizeUserPath(raw, { expandEnv: false })) {
    return {
      ok: false,
      body: {
        error: `Zomboid data path does not exist: ${raw}. Check for typos and verify the panel has read access to this folder.`,
      },
    };
  }
  if (verdict.ok) return { ok: true, path: resolved };
  if (verdict.reason === "not-a-directory") {
    return {
      ok: false,
      body: {
        error: `Zomboid data path is not a directory: ${raw}`,
        code: ErrorCode.ZOMBOID_DATA_PATH_INVALID,
      },
    };
  }
  return {
    ok: false,
    body: {
      error:
        verdict.reason === "install-folder"
          ? "This folder looks like a Project Zomboid server install, not a user data folder. Point at the Zomboid user data folder instead."
          : NOT_A_DATA_FOLDER_MESSAGE,
      code: ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER,
    },
  };
}

/**
 * Use time: whether a data folder a feature is about to list or read under
 * still meets the rule. Takes the path as the feature will use it -- no
 * normalization.
 */
export function zomboidDataFolderHolds(dataPath) {
  if (!hasPathShape(dataPath) || !path.isAbsolute(dataPath)) return false;
  return judgeFolder(path.resolve(dataPath)).ok;
}

// The response body for a data folder refused at use time.
export function zomboidDataFolderRefusal() {
  return {
    error:
      "This server's Zomboid data folder holds files the game doesn't keep in a data folder, so the panel won't list or read it. On the Servers page, edit the server and set its Zomboid data folder to the game's own, the one with a Saves folder.",
    code: ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER,
  };
}
