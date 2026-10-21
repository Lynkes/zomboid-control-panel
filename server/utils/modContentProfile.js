// What a mod's loaded folders contain, summarised for the mod classifier
// (utils/modClassification.js) and the health check (utils/modHealth.js).
//
// Only the folders Build 42 loads are read (gameMediaDirs: common/ then the
// newest 42.x folder, a root media/ for the old layout), so a file in a B41
// folder or in an older version folder never counts. Paths are relative to
// media/.
//
// The walk is bounded on purpose: a Workshop item is someone else's content
// and a texture or model pack can hold tens of thousands of files that say
// nothing about what KIND of mod it is. media/lua (Lua and translations) and
// the first two levels of media/maps are read in full (up to the per-mod cap);
// every other top-level folder is only counted up to a small cap.

import fs from "fs";
import path from "path";
import { gameMediaDirs, isNonGameplayMediaFile } from "./modConflictRules.js";

export const CONTENT_PROFILE_LIMITS = Object.freeze({
  // Files read per mod (all folders together).
  maxFilesPerMod: 20_000,
  // Files counted per top-level folder other than lua/ and maps/.
  maxFilesPerOtherFolder: 300,
  maxDepth: 20,
  // Lua paths kept per mod (for "does it override a file of the mod it
  // patches"); a profile past it is `luaPathsTruncated`.
  maxLuaPaths: 3000,
  maxMapFolders: 50,
  // Profiles kept in memory, and for how long one is trusted.
  cacheMaxEntries: 5000,
  cacheTtlMs: 10 * 60 * 1000,
  // Mod folders walked at once.
  concurrency: 8,
});

// media/maps/<folder> holds a map when one of these is directly inside it
// (the same test as services/workshopModInfo.js isValidMapFolder).
function isMapDataFile(lowerBase) {
  return (
    lowerBase.endsWith(".lotheader") ||
    lowerBase === "objects.lua" ||
    lowerBase.endsWith(".lotpack") ||
    lowerBase.startsWith("world_") ||
    lowerBase.startsWith("chunkdata_")
  );
}

function emptyProfile() {
  return {
    files: 0,
    truncated: false,
    lua: 0,
    luaClient: 0,
    luaServer: 0,
    luaShared: 0,
    luaPaths: [],
    luaPathsTruncated: false,
    translation: 0,
    translationJson: 0,
    scripts: 0,
    maps: 0,
    mapFolders: [],
    textures: 0,
    models: 0,
    audio: 0,
    ui: 0,
    clothing: 0,
    sandboxOptions: false,
    other: 0,
  };
}

/**
 * Summary of a mod's loaded files from their paths relative to media/ (any
 * case, "/" or "\" separators). Files the game never reads for gameplay
 * (mod.info, workshop.txt, readmes, Workshop art) are left out.
 *
 *   files            gameplay files counted
 *   lua / luaClient / luaServer / luaShared   .lua files (and where)
 *   luaPaths         lower-cased media-relative Lua paths (capped)
 *   translation      files under lua/shared/Translate/ that are not Lua
 *   translationJson  of those, the .json ones (the only ones B42 reads)
 *   scripts          media/scripts files
 *   maps / mapFolders  media/maps files, and the map folders that hold map
 *                    data (name as on disk)
 *   textures / models / audio / ui / clothing / other   counts
 *   sandboxOptions   ships a sandbox-options.txt
 */
export function summarizeModFiles(relPaths, { truncated = false } = {}) {
  const profile = emptyProfile();
  profile.truncated = truncated === true;
  const mapFolders = new Map(); // lower-cased name -> name as written
  for (const raw of relPaths || []) {
    if (typeof raw !== "string") continue;
    const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || isNonGameplayMediaFile(rel)) continue;
    const lower = rel.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    profile.files++;
    if (lower.startsWith("lua/")) {
      if (lower.startsWith("lua/shared/translate/") && !lower.endsWith(".lua")) {
        profile.translation++;
        if (lower.endsWith(".json")) profile.translationJson++;
        continue;
      }
      if (!lower.endsWith(".lua")) {
        profile.other++;
        continue;
      }
      profile.lua++;
      if (lower.startsWith("lua/client/")) profile.luaClient++;
      else if (lower.startsWith("lua/server/")) profile.luaServer++;
      else if (lower.startsWith("lua/shared/")) profile.luaShared++;
      if (profile.luaPaths.length < CONTENT_PROFILE_LIMITS.maxLuaPaths) profile.luaPaths.push(lower);
      else profile.luaPathsTruncated = true;
      continue;
    }
    if (lower.startsWith("scripts/")) {
      profile.scripts++;
      continue;
    }
    if (lower.startsWith("maps/")) {
      profile.maps++;
      const parts = rel.split("/");
      if (parts.length === 3 && parts[1] && isMapDataFile(base)) {
        const key = parts[1].toLowerCase();
        if (!mapFolders.has(key) && mapFolders.size < CONTENT_PROFILE_LIMITS.maxMapFolders) {
          mapFolders.set(key, parts[1]);
        }
      }
      continue;
    }
    if (base === "sandbox-options.txt") {
      profile.sandboxOptions = true;
      continue;
    }
    if (lower.startsWith("clothing/")) profile.clothing++;
    else if (lower.startsWith("ui/")) profile.ui++;
    else if (lower.startsWith("sound/") || lower.startsWith("music/") || /\.(?:ogg|wav|bank)$/.test(base)) profile.audio++;
    else if (lower.startsWith("models/") || lower.startsWith("models_x/") || /\.(?:fbx|x|glb)$/.test(base)) profile.models++;
    else if (
      lower.startsWith("texturepacks/") ||
      lower.startsWith("textures/") ||
      /\.(?:pack|png|jpe?g|dds|tga)$/.test(base)
    ) {
      profile.textures++;
    } else profile.other++;
  }
  profile.mapFolders = [...mapFolders.values()];
  return profile;
}

/**
 * Profiles of the mods a conflict scan indexed, without reading anything
 * again: `fileIndex` is buildFileIndex()'s { relPath: [{ modId }] } (paths
 * lower-cased relative to media/). Returns Map<modId, profile>, plus each
 * mod's file count in `fileCounts` (Map<modId, number>).
 */
export function profilesFromFileIndex(fileIndex) {
  const pathsByMod = new Map();
  for (const [relPath, entries] of Object.entries(fileIndex || {})) {
    if (!Array.isArray(entries)) continue;
    const seen = new Set();
    for (const entry of entries) {
      const modId = entry?.modId;
      if (typeof modId !== "string" || seen.has(modId)) continue;
      seen.add(modId);
      if (!pathsByMod.has(modId)) pathsByMod.set(modId, []);
      pathsByMod.get(modId).push(relPath);
    }
  }
  const profiles = new Map();
  const fileCounts = new Map();
  for (const [modId, paths] of pathsByMod) {
    profiles.set(modId, summarizeModFiles(paths));
    fileCounts.set(modId, paths.length);
  }
  return { profiles, fileCounts };
}

// ─── Reading a mod folder ────────────────────────────────────────────────

const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

async function listDir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Relative file paths under `dir` (prefix + "/" + name), depth-first, at most
// `budget.left` files. Symbolic links are not followed: a link out of the
// mod's folder must never be read.
async function collectFiles(dir, prefix, depth, budget, out, perFolderCap = Infinity) {
  if (depth > CONTENT_PROFILE_LIMITS.maxDepth || budget.left <= 0) return;
  let taken = 0;
  const pending = [{ dir, prefix, depth }];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await listDir(current.dir);
    for (const entry of entries) {
      if (budget.left <= 0 || taken >= perFolderCap) {
        budget.truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const rel = `${current.prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (current.depth < CONTENT_PROFILE_LIMITS.maxDepth) {
          pending.push({ dir: path.join(current.dir, entry.name), prefix: rel, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        out.push(rel);
        budget.left--;
        taken++;
        if (++budget.sinceYield >= 1000) {
          budget.sinceYield = 0;
          await yieldTick();
        }
      }
    }
  }
}

/**
 * The media-relative paths of one mod folder's loaded files, with the bounds
 * described at the top of this file. A later media folder's copy of a path
 * replaces the earlier one (one entry per path). Returns { paths, truncated,
 * layout } or null when the folder cannot be read.
 */
export async function readModMediaPaths(modDirPath) {
  const { layout, dirs } = gameMediaDirs(modDirPath);
  if (!layout) return null;
  const budget = { left: CONTENT_PROFILE_LIMITS.maxFilesPerMod, truncated: false, sinceYield: 0 };
  const seen = new Set();
  const paths = [];
  for (const mediaDir of dirs) {
    const top = await listDir(mediaDir);
    const files = [];
    for (const entry of top) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) {
        files.push(entry.name);
        budget.left--;
        continue;
      }
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const lower = name.toLowerCase();
      const full = path.join(mediaDir, name);
      if (lower === "lua") {
        await collectFiles(full, name, 1, budget, files);
      } else if (lower === "maps") {
        // media/maps/<folder>/<file>: two levels are enough to tell a map
        // (depth 20 is the cap, so collectFiles does not descend further).
        for (const folder of await listDir(full)) {
          if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
          await collectFiles(path.join(full, folder.name), `${name}/${folder.name}`, 20, budget, files, 200);
        }
      } else {
        await collectFiles(full, name, 1, budget, files, CONTENT_PROFILE_LIMITS.maxFilesPerOtherFolder);
      }
    }
    for (const rel of files) {
      const key = rel.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(rel);
    }
  }
  return { paths, truncated: budget.truncated, layout };
}

const profileCache = new Map(); // modDirPath -> { at, profile, stamp }

function folderStamp(modDirPath) {
  try {
    const stat = fs.statSync(modDirPath);
    return `${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * The content profile of one mod folder (summarizeModFiles of its loaded
 * files), cached for cacheTtlMs per folder (and while the folder's own
 * modification time is unchanged). null when the folder has no loadable
 * layout or cannot be read. `layout` is "b42" or "legacy".
 */
export async function profileModFolder(modDirPath, { now = Date.now(), fresh = false } = {}) {
  const stamp = folderStamp(modDirPath);
  if (stamp === null) return null;
  const cached = profileCache.get(modDirPath);
  if (!fresh && cached && cached.stamp === stamp && now - cached.at < CONTENT_PROFILE_LIMITS.cacheTtlMs) {
    profileCache.delete(modDirPath);
    profileCache.set(modDirPath, cached);
    return cached.profile;
  }
  const read = await readModMediaPaths(modDirPath);
  const profile = read ? { ...summarizeModFiles(read.paths, { truncated: read.truncated }), layout: read.layout } : null;
  profileCache.delete(modDirPath);
  profileCache.set(modDirPath, { at: now, stamp, profile });
  while (profileCache.size > CONTENT_PROFILE_LIMITS.cacheMaxEntries) {
    profileCache.delete(profileCache.keys().next().value);
  }
  return profile;
}

/**
 * Profiles of many mod folders, a few at a time. `folders` is
 * [{ key, dir }]; returns Map<key, profile|null>.
 */
export async function profileModFolders(folders, options = {}) {
  const out = new Map();
  const list = Array.isArray(folders) ? folders : [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const { key, dir } = list[next++];
      try {
        out.set(key, await profileModFolder(dir, options));
      } catch {
        out.set(key, null);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONTENT_PROFILE_LIMITS.concurrency, list.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

export function clearContentProfileCache() {
  profileCache.clear();
}
