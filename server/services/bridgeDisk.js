/**
 * What PanelBridge looks like on a server's disk, and moving the loose copy
 * out of the way. Filesystem only -- no database, no settings -- so the
 * delivery service (bridgeDelivery.js), diagnostics and mount discovery can
 * all ask the same questions the same way.
 *
 * "Loose" files are the ones the panel-installed delivery puts straight into
 * the game install: media/lua/server/PanelBridge.lua, plus two leftovers
 * older panels also wrote (the client companion and a root mod.info). With
 * Steam Workshop delivery they must not stay there: the game hashes the
 * loose copy at the base-game position of the Lua list while players hash
 * the mod copy at the mod position, so with DoLuaChecksum on every join is
 * refused even though the file contents match.
 *
 * Loose files are never deleted. They are MOVED into the panel's data folder
 * (bridge-delivery-archive/), with a manifest, so an operator who had
 * hand-edited one can get it back and a failed switch can put it back.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDataPaths } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/fileWriteQueue.js";
import { scanWorkshopInstallFolder } from "../utils/workshopLogScan.js";
import { getWorkshopAcfCandidates } from "./modChecker.js";
import { BRIDGE_MOD_ID } from "./bridgeDeliveryContract.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("BridgeDisk");

const SERVER_MARKER = "PanelBridge - Server-side mod for Zomboid Control Panel";
const CLIENT_MARKER = "PanelBridge client companion";
const HEAD_BYTES = 4096;
const ARCHIVE_DIR_NAME = "bridge-delivery-archive";
const ARCHIVES_KEPT_PER_INSTALL = 5;

// The folder's real path when it exists (path.resolve otherwise), no
// trailing separator, case-folded on Windows (where C:\PZ and c:\pz\ are
// the same folder). Two profiles pointing at the same game install must
// produce the same key, because loose files live in the install folder and
// so belong to every profile that uses it -- including when they reach it
// by different paths: a junction or symlink, or a mapped drive and its UNC
// path. Keyed on the spelling alone, those were two groups, and a Local
// profile's launch wrote a loose PanelBridge.lua into the folder a Workshop
// profile uses (I3), refusing its players while DoLuaChecksum is on.
export function installDirKey(dir) {
  if (!dir) return null;
  let resolved = path.resolve(String(dir));
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Not there (yet), or unreadable: the path as written.
  }
  const root = path.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir).map(String);
  } catch {
    return [];
  }
}

function isKind(fullPath, wantDirectory) {
  try {
    const stat = fs.statSync(fullPath);
    return wantDirectory ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function childDirectories(dir) {
  return readDirNames(dir).filter((name) => isKind(path.join(dir, name), true));
}

// Every child of `dir` whose name matches `name` ignoring case. On Linux a
// game folder can hold both PanelBridge.lua and panelbridge.lua (the game
// itself lowercases paths when it hashes them), and both are leftovers.
// Only the matching names are stat'ed, so scanning a large install folder
// stays cheap.
function childrenNamed(dir, name, wantDirectory) {
  const lower = name.toLowerCase();
  return readDirNames(dir)
    .filter((entry) => entry.toLowerCase() === lower)
    .map((entry) => path.join(dir, entry))
    .filter((fullPath) => isKind(fullPath, wantDirectory));
}

function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
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

function readModInfoLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
  } catch {
    return null;
  }
}

export function listLooseBridgeFiles(installDir) {
  if (!installDir) return [];
  const files = [];
  for (const mediaDir of childrenNamed(installDir, "media", true)) {
    for (const luaDir of childrenNamed(mediaDir, "lua", true)) {
      for (const serverDir of childrenNamed(luaDir, "server", true)) {
        for (const file of childrenNamed(serverDir, "PanelBridge.lua", false)) {
          files.push({ path: file, kind: "server", recognized: readHead(file).includes(SERVER_MARKER) });
        }
      }
      for (const clientDir of childrenNamed(luaDir, "client", true)) {
        for (const file of childrenNamed(clientDir, "PanelBridgeClient.lua", false)) {
          files.push({ path: file, kind: "client", recognized: readHead(file).includes(CLIENT_MARKER) });
        }
      }
    }
  }
  // Only a mod.info that is PanelBridge's own: the game ignores a root
  // mod.info, but an operator's install can still hold an unrelated one.
  // Older panels wrote it with id=PanelBridge; an installer from a dev tree
  // between the Workshop mod.info landing and the installer no longer
  // writing a root copy wrote it with the Workshop mod id.
  for (const file of childrenNamed(installDir, "mod.info", false)) {
    const lines = readModInfoLines(file);
    if (lines && (lines.includes("id=PanelBridge") || lines.includes(`id=${BRIDGE_MOD_ID}`))) {
      files.push({ path: file, kind: "rootModInfo", recognized: true });
    }
  }
  return files;
}

function archiveStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function installArchiveRoot(installDir) {
  const hash = crypto.createHash("sha1").update(installDirKey(installDir) || "").digest("hex").slice(0, 12);
  return path.join(getDataPaths().dataDir, ARCHIVE_DIR_NAME, hash);
}

function uniqueArchiveDir(root) {
  const base = path.join(root, archiveStamp());
  let candidate = base;
  for (let suffix = 2; fs.existsSync(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

// A bridge file's mode and owner, so a rollback can put them back too.
// installBridge() writes PanelBridge.lua 0644 and chowns it to the game
// folder's owner so a PZ server running as another user can read it; a
// plain rewrite would leave the panel user's umask mode and ownership
// instead (0600 and unreadable to the game under umask 077). Null on
// Windows, where neither applies.
export function readBridgeFileMeta(filePath) {
  if (process.platform === "win32") return null;
  try {
    const { mode, uid, gid } = fs.statSync(filePath);
    return { mode: mode & 0o7777, uid, gid };
  } catch {
    return null;
  }
}

// Best-effort, like installBridge()'s own chown: changing the owner needs
// privileges the panel often doesn't have, and the content is what matters
// most. Owner first, since a chown can clear mode bits.
function applyBridgeFileMeta(filePath, meta) {
  if (!meta || process.platform === "win32") return;
  try {
    fs.chownSync(filePath, meta.uid, meta.gid);
  } catch (error) {
    log.debug(`Could not restore the owner of ${filePath}: ${error.message}`);
  }
  try {
    fs.chmodSync(filePath, meta.mode);
  } catch (error) {
    log.warn(`Could not restore the mode of ${filePath}: ${error.message}`);
  }
}

// Copy + fsync + unlink rather than rename: the panel's data folder and the
// game install are often on different drives or mounts, where rename fails.
function moveFileDurably(from, to) {
  const data = fs.readFileSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const fd = fs.openSync(to, "wx");
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best-effort: some filesystems reject fsync */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(from);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function pruneOldArchives(root) {
  // Stamp names sort chronologically (a same-second "-2" suffix sorts after
  // its base), so the newest are first after a reverse sort.
  const dirs = childDirectories(root).sort().reverse();
  for (const name of dirs.slice(ARCHIVES_KEPT_PER_INSTALL)) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch (error) {
      log.warn(`Could not prune old PanelBridge archive ${name}: ${error.message}`);
    }
  }
}

function restoreEntries(entries) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try {
      const data = fs.readFileSync(entry.to);
      fs.mkdirSync(path.dirname(entry.from), { recursive: true });
      writeFileAtomic(entry.from, data);
      applyBridgeFileMeta(entry.from, entry.meta);
      fs.unlinkSync(entry.to);
    } catch (error) {
      failures.push(`${entry.from}: ${error.message}`);
    }
  }
  return failures;
}

/**
 * Moves `files` (DeliveryLooseFile entries under `installDir`) into
 * <dataDir>/bridge-delivery-archive/<install hash>/<UTC stamp>/, keeping
 * their install-relative paths, and writes manifest.json beside them. On a
 * failure part-way through, whatever was already moved is put back before
 * the error is rethrown with `fileName` set to the file that failed, so the
 * install folder is never left half-archived.
 */
export async function archiveLooseBridgeFiles(installDir, files, { reason = "manual" } = {}) {
  const list = (files || []).filter((file) => file?.path);
  if (list.length === 0) return { archiveDir: null, moved: [], entries: [] };

  const root = installArchiveRoot(installDir);
  const archiveDir = uniqueArchiveDir(root);
  const entries = [];
  let current = null;
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const file of list) {
      current = file.path;
      let relative = path.relative(installDir, file.path);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        relative = path.basename(file.path);
      }
      const to = path.join(archiveDir, relative);
      const meta = readBridgeFileMeta(file.path);
      const sha256 = moveFileDurably(file.path, to);
      entries.push({ from: file.path, to, sha256, meta });
    }
    current = null;
    const manifest = {
      installDir,
      reason,
      at: new Date().toISOString(),
      files: entries.map(({ from, to, sha256 }) => ({ from, to, sha256 })),
    };
    fs.writeFileSync(path.join(archiveDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const failures = restoreEntries(entries);
    if (failures.length) {
      log.error(`Could not put back PanelBridge files after a failed archive: ${failures.join("; ")}`);
    } else {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      } catch {
        /* an empty leftover archive folder is harmless */
      }
    }
    error.fileName = path.basename(current || list[0].path);
    error.restored = failures.length === 0;
    throw error;
  }

  pruneOldArchives(root);
  log.info(`Moved ${entries.length} PanelBridge file(s) out of ${installDir} into ${archiveDir} (${reason})`);
  return { archiveDir, moved: entries.map((entry) => entry.from), entries };
}

// Undo for archiveLooseBridgeFiles(): moves every archived file back to where
// it came from and drops the now-empty archive. Throws when any file could
// not be put back, so the caller reports the rollback as incomplete.
export async function restoreArchivedBridgeFiles(archiveResult) {
  const entries = archiveResult?.entries || [];
  if (entries.length === 0) return;
  const failures = restoreEntries(entries);
  if (failures.length) {
    throw new Error(`Could not restore PanelBridge files: ${failures.join("; ")}`);
  }
  try {
    fs.rmSync(archiveResult.archiveDir, { recursive: true, force: true });
  } catch {
    /* an empty leftover archive folder is harmless */
  }
}

// Undo for an in-place PanelBridge.lua rewrite: puts the exact bytes that
// were there before back, with the mode and owner readBridgeFileMeta()
// recorded before the rewrite. Lives here, not in bridgeDelivery.js, because
// this module and the installer are the only places allowed to write a
// bridge file (bridgeSingleWriterGate.test.js).
export function restoreBridgeFileBytes(filePath, bytes, meta = null) {
  writeFileAtomic(filePath, bytes);
  applyBridgeFileMeta(filePath, meta);
}

function readModVersion(lines) {
  const line = lines.find((entry) => entry.startsWith("modversion="));
  const value = line ? line.slice("modversion=".length).trim() : "";
  return value || null;
}

// A downloaded item folder counts as PanelBridge's only when one of its
// mods declares id=ZomboidControlPanelBridge in a B42-loadable place
// (common/ or a numeric version folder -- the game ignores a root
// mod.info). Returns { version } or null.
function inspectBridgeItemFolder(folder) {
  for (const modDir of childDirectories(path.join(folder, "mods"))) {
    const modPath = path.join(folder, "mods", modDir);
    for (const layer of childDirectories(modPath)) {
      if (layer !== "common" && !/^\d+(\.\d+)*$/.test(layer)) continue;
      const lines = readModInfoLines(path.join(modPath, layer, "mod.info"));
      if (!lines) continue;
      const idLine = lines.find((line) => line.startsWith("id="));
      if (idLine && idLine.slice(3).trim() === BRIDGE_MOD_ID) {
        return { version: readModVersion(lines) };
      }
    }
  }
  return null;
}

/**
 * Where the server downloaded the PanelBridge Workshop item, or null.
 * The server's own log line wins; otherwise the SteamCMD layouts next to the
 * install (the same candidates modChecker uses for appworkshop_108600.acf).
 * The operator's own Steam client folders are deliberately NOT searched: a
 * player subscription on the same PC would look like a server download.
 */
export function detectWorkshopItem(installDir, workshopId, { zomboidDataPath = null } = {}) {
  if (!workshopId) return null;
  const id = String(workshopId);
  const fromLog = scanWorkshopInstallFolder(zomboidDataPath, id);
  if (fromLog) {
    const found = inspectBridgeItemFolder(fromLog);
    if (found) return { folder: fromLog, version: found.version, source: "log" };
  }
  if (!installDir) return null;
  for (const acf of getWorkshopAcfCandidates(installDir)) {
    const folder = path.join(path.dirname(acf), "content", "108600", id);
    const found = inspectBridgeItemFolder(folder);
    if (found) return { folder, version: found.version, source: "candidate" };
  }
  return null;
}

// Mount discovery's "does this install already carry PanelBridge" answer,
// covering both deliveries.
export function detectBridgeOnDisk(installDir, workshopId) {
  return {
    loose: listLooseBridgeFiles(installDir).some((file) => file.kind === "server"),
    workshopItem: Boolean(detectWorkshopItem(installDir, workshopId)),
  };
}
