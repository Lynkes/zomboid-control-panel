import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pickModVersionFolder } from "./modLoadOrder.js";

// The rules the mod conflict scanner (routes/mods.js) applies on top of "two
// mods ship the same path", taken from what the game really loads and merges
// (see the ground-truth notes at the top of utils/modLoadOrder.js).

// ─── Files that never affect gameplay ─────────────────────────────────────
// Paths are relative to a mod's media/ folder and lower-cased (the scanner's
// index keys). Workshop metadata and documentation ship in many mods with
// different bytes and are never read by the game; images named like Workshop
// art count only at the media/ root (media/ui/icon.png is a real asset).
const NEVER_LOADED_NAMES = new Set([
  "mod.info",
  "workshop.txt",
  ".gitkeep",
  ".gitignore",
  ".gitattributes",
  ".keep",
  "thumbs.db",
  "desktop.ini",
  ".ds_store",
]);
const DOC_FILE_RE = /^(?:readme|read_me|license|licence|changelog|changes|credits|copying|notice)(?:[_-][\w-]*)?(?:\.(?:txt|md|markdown|rtf|pdf|html?))?$/;
const ROOT_ART_RE = /^(?:poster|preview|icon|thumbnail|thumb|banner)\d*\.(?:png|jpe?g|gif|bmp|webp)$/;

/**
 * True for a media/-relative path the game never reads for gameplay:
 * Workshop/VCS metadata anywhere, documentation outside scripts/ (the script
 * loader parses every .txt there), Workshop art at the media root.
 */
export function isNonGameplayMediaFile(relPath) {
  const lower = String(relPath).toLowerCase();
  const parts = lower.split("/");
  const base = parts[parts.length - 1];
  if (NEVER_LOADED_NAMES.has(base)) return true;
  if (parts.length === 1 && ROOT_ART_RE.test(base)) return true;
  if (!lower.startsWith("scripts/") && DOC_FILE_RE.test(base)) return true;
  return false;
}

// ─── Which folders of a mod the game loads ────────────────────────────────
/**
 * The media/ folders of one mod folder the scanner should read, in the order
 * the game applies them (a later folder's copy of a path wins):
 *   B42 layout (a common/ folder or a version folder such as 42, 42.13):
 *     [common/media, <newest 42.x folder>/media], each when it exists. Any
 *     root media/ is never loaded by B42 and older version folders are not
 *     the one the game picks.
 *   Old layout (neither): [media] when it exists.
 * Returns { layout: "b42" | "legacy" | null, dirs, versionFolder }.
 */
export function gameMediaDirs(modDirPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(modDirPath, { withFileTypes: true });
  } catch {
    return { layout: null, dirs: [], versionFolder: null };
  }
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const common = folders.find((name) => name.toLowerCase() === "common") || null;
  const versionFolder = pickModVersionFolder(folders);
  if (common || versionFolder) {
    const dirs = [];
    for (const folder of [common, versionFolder]) {
      if (!folder) continue;
      const media = path.join(modDirPath, folder, "media");
      if (fs.existsSync(media)) dirs.push(media);
    }
    return { layout: "b42", dirs, versionFolder };
  }
  const media = path.join(modDirPath, "media");
  return { layout: fs.existsSync(media) ? "legacy" : null, dirs: fs.existsSync(media) ? [media] : [], versionFolder: null };
}

// ─── Per-file cache (content hash and parses), validated by size + mtime ────
// A rescan of unchanged mods reuses every hash and parse; a changed file
// (other size or mtime) is read again. Bounded; the oldest entries go first.
export const FILE_CACHE_MAX_ENTRIES = 100_000;
const fileCache = new Map();

function cacheEntry(absPath, stat) {
  let entry = fileCache.get(absPath);
  if (entry && (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs)) entry = undefined;
  if (!entry) {
    entry = { size: stat.size, mtimeMs: stat.mtimeMs, hash: undefined, parsed: new Map() };
  } else {
    fileCache.delete(absPath);
  }
  fileCache.set(absPath, entry);
  while (fileCache.size > FILE_CACHE_MAX_ENTRIES) {
    fileCache.delete(fileCache.keys().next().value);
  }
  return entry;
}

/** { size, mtimeMs } of a regular file, or null. */
export async function statFile(absPath) {
  try {
    const st = await fs.promises.stat(absPath);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function statFileSync(absPath) {
  try {
    const st = fs.statSync(absPath);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function hashStream(absPath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", () => resolve(null));
  });
}

/** md5 of a file's bytes, cached by path + size + mtime. null when unreadable. */
export async function cachedFileHash(absPath, stat) {
  const st = stat || (await statFile(absPath));
  if (!st) return null;
  const entry = cacheEntry(absPath, st);
  if (entry.hash === undefined) entry.hash = await hashStream(absPath);
  return entry.hash;
}

/**
 * extractor(absPath), cached per `kind` by path + size + mtime. Returns
 * undefined when the file cannot be stat'ed.
 */
export function cachedParse(kind, absPath, extractor) {
  const st = statFileSync(absPath);
  if (!st) return undefined;
  const entry = cacheEntry(absPath, st);
  if (!entry.parsed.has(kind)) entry.parsed.set(kind, extractor(absPath));
  return entry.parsed.get(kind);
}

export function clearConflictFileCache() {
  fileCache.clear();
}

// The cache only pays off while an admin is rescanning; it is dropped after
// `ms` without a scan so a big modlist's parses do not stay in memory.
let expiryTimer = null;
export function expireConflictFileCacheAfter(ms) {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    fileCache.clear();
  }, ms);
  expiryTimer.unref?.();
}

export function conflictFileCacheSize() {
  return fileCache.size;
}

// ─── Translations ─────────────────────────────────────────────────────────
/**
 * { lang, file, json } for media/lua/shared/Translate/<LANG>/<file>, else
 * null. B42 reads only the .json files.
 */
export function translationPathInfo(relPath) {
  const m = /^lua\/shared\/translate\/([^/]+)\/(.+)$/i.exec(String(relPath));
  if (!m) return null;
  return { lang: m[1], file: m[2], json: /\.json$/i.test(m[2]) };
}

/**
 * The keys several mods give different non-empty values in one language file
 * (an empty value never replaces another in the game). `copies` is
 * [{ modId, entries: Map | null }] in load order (later wins). Returns
 * { conflicting: [key], modIds: [modId], sameValue: count, unreadable,
 * unreadableModIds }: modIds are the mods giving a conflicting key a value
 * (every other mod shipping the file is not part of the conflict).
 */
export function compareTranslationEntries(copies) {
  const values = new Map();
  const unreadableModIds = [];
  for (const copy of copies) {
    if (!copy.entries) {
      unreadableModIds.push(copy.modId);
      continue;
    }
    for (const [key, value] of copy.entries) {
      if (value === "") continue;
      if (!values.has(key)) values.set(key, new Map());
      values.get(key).set(copy.modId, value);
    }
  }
  const conflicting = [];
  const modIds = new Set();
  let sameValue = 0;
  for (const [key, byMod] of values) {
    if (byMod.size < 2) continue;
    if (new Set(byMod.values()).size > 1) {
      conflicting.push(key);
      for (const modId of byMod.keys()) modIds.add(modId);
    } else {
      sameValue++;
    }
  }
  return {
    conflicting,
    modIds: [...modIds],
    sameValue,
    unreadable: unreadableModIds.length > 0,
    unreadableModIds,
  };
}

// ─── Scripts ──────────────────────────────────────────────────────────────
/**
 * Two mods' copies of one script path: only the winner's copy is parsed by
 * the game. `winnerDefs` / `loserDefs` are extractScriptDefinitionBodies()
 * maps. Returns { lost: [name], overridden: [name], same: count }:
 *   lost        defined only by the losing copy -- gone from the game
 *   overridden  both define it, with different bodies -- winner's applies
 */
/**
 * Two layered bodies (vehicle, xuiSkin) of one name: the game applies the
 * later on top of the earlier, key by key, so only a key both set with a
 * different value is overridden. `a` / `b` are Map<key, { hash }> (the
 * layers of every file of each mod). Returns the clashing keys, sorted.
 */
export function compareLayeredDefinitions(a, b) {
  const clashing = [];
  for (const [key, layer] of a) {
    const other = b.get(key);
    if (other && other.hash !== layer.hash) clashing.push(key);
  }
  return clashing.sort();
}

export function compareScriptFileCopies(winnerDefs, loserDefs) {
  const lost = [];
  const overridden = [];
  let same = 0;
  for (const [name, def] of loserDefs) {
    const other = winnerDefs.get(name);
    if (!other) lost.push(name);
    else if (other.hash !== def.hash) overridden.push(name);
    else same++;
  }
  return { lost, overridden, same };
}
