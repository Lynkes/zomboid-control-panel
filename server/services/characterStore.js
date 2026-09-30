import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";

const log = createLogger("CharacterStore");

// Per-player character cache for the Players page's Character tab:
//   <dataDir>/character-sheets/<serverId>/<sha256(lower(username))[0,32]>.json
// holding the last sheet the panel read (so an offline player still shows
// something) and a short history of skill levels (so a jump can be noticed).
// Only the panel writes here, it never reads the game's players.db, and it is
// not part of the support bundle.

export const CHARACTER_STORE_DIR = "character-sheets";

export const CHARACTER_STORE_LIMITS = Object.freeze({
  maxSnapshots: 96,
  snapshotMinGapMs: 5 * 60 * 1000,
  maxBytes: 512 * 1024,
  deltaMinAgeMs: 2 * 60 * 1000,
  deltaMaxAgeMs: 60 * 60 * 1000,
});

const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_FILE_RE = /^[0-9a-f]{32}\.json$/;
const SNAPSHOT_SOURCES = new Set(["view", "login", "sampler"]);

// Sections a fetch can carry, and the top-level sheet keys each one owns.
const SECTION_KEYS = Object.freeze({
  summary: ["summary"],
  stats: ["stats", "health"],
  skills: ["skills"],
  traits: ["traits"],
  inventory: ["inventory"],
});
const IDENTITY_KEYS = ["schema", "generatedAt", "username", "displayName", "forename", "surname", "role"];

function storeRoot() {
  return path.join(getDataPaths().dataDir, CHARACTER_STORE_DIR);
}

export function isValidCharacterServerId(serverId) {
  return typeof serverId === "string" && SERVER_ID_RE.test(serverId);
}

/**
 * The record file for one player on one server, or null for an id that
 * can't be a directory name. The username only ever reaches the filesystem
 * as a hash, so a name like "../x" can't pick a path.
 */
export function characterRecordPath(serverId, username) {
  if (!isValidCharacterServerId(serverId)) return null;
  if (typeof username !== "string" || username.length === 0) return null;
  const hash = crypto.createHash("sha256").update(username.toLowerCase(), "utf8").digest("hex").slice(0, 32);
  return path.join(storeRoot(), serverId, `${hash}.json`);
}

function readRecordFile(file) {
  try {
    // codeql[js/path-injection] file comes from characterRecordPath(): <dataDir>/character-sheets/<serverId>/<hex>.json, where serverId passed ^[A-Za-z0-9_-]{1,64}$ and the name is a sha256 hex digest, so it can't leave the store folder.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schema !== 1) return null;
    if (!Array.isArray(parsed.snapshots)) parsed.snapshots = [];
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") log.debug(`Unreadable character record ignored: ${error.message}`);
    return null;
  }
}

export async function readCharacterRecord(serverId, username) {
  const file = characterRecordPath(serverId, username);
  if (!file) return null;
  return readRecordFile(file);
}

function levelsAndXp(sheet) {
  const levels = {};
  const xp = {};
  for (const perk of sheet?.skills?.perks ?? []) {
    if (!perk?.id) continue;
    if (typeof perk.level === "number") levels[perk.id] = perk.level;
    if (typeof perk.xp === "number") xp[perk.id] = perk.xp;
  }
  return { levels, xp };
}

function isNewLife(previous, summary) {
  if (!previous || !summary) return false;
  const lower = (key) =>
    typeof previous[key] === "number" && typeof summary[key] === "number" && summary[key] < previous[key];
  return lower("hoursSurvived") || lower("zombieKills");
}

/**
 * Skill changes since a baseline snapshot: the newest one 2 to 60 minutes
 * old, else the login snapshot of this life, else none. Pure.
 */
export function computeSkillDelta(snapshots, sheet, now) {
  if (!sheet?.skills || !Array.isArray(snapshots) || snapshots.length === 0) return null;
  const { levels, xp } = levelsAndXp(sheet);
  let baseline = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const age = now - snapshots[i].at;
    if (age >= CHARACTER_STORE_LIMITS.deltaMinAgeMs && age <= CHARACTER_STORE_LIMITS.deltaMaxAgeMs) {
      baseline = snapshots[i];
      break;
    }
  }
  if (!baseline) {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].source === "login" && snapshots[i].at <= now) {
        baseline = snapshots[i];
        break;
      }
    }
  }
  if (!baseline) return null;
  const perks = [];
  for (const [perkId, toLevel] of Object.entries(levels)) {
    const fromLevel = baseline.levels?.[perkId];
    if (typeof fromLevel !== "number" || fromLevel === toLevel) continue;
    const change = { id: perkId, fromLevel, toLevel };
    if (typeof baseline.xp?.[perkId] === "number") change.fromXp = baseline.xp[perkId];
    if (typeof xp[perkId] === "number") change.toXp = xp[perkId];
    perks.push(change);
  }
  return { since: new Date(baseline.at).toISOString(), source: baseline.source, perks };
}

function emptyRecord(serverId, username) {
  return {
    schema: 1,
    username,
    serverId,
    lastSheet: null,
    lastSheetAt: null,
    lastInventoryAt: null,
    snapshots: [],
  };
}

function mergeSections(lastSheet, sheet, sections) {
  const merged = { ...(lastSheet ?? {}) };
  for (const key of IDENTITY_KEYS) {
    if (sheet[key] !== undefined) merged[key] = sheet[key];
  }
  let inventoryMerged = false;
  for (const section of sections) {
    if (sheet.sectionErrors?.[section]) continue;
    for (const key of SECTION_KEYS[section] ?? []) {
      if (sheet[key] === undefined) continue;
      merged[key] = sheet[key];
      if (key === "inventory") inventoryMerged = true;
    }
  }
  delete merged.sectionErrors;
  delete merged.cost;
  return { merged, inventoryMerged };
}

function applySheet(record, sheet, { source, sections, now }) {
  const summary = sheet.summary;
  const newestSnapshot = record.snapshots.at(-1);
  const previousSummary = newestSnapshot ?? record.lastSheet?.summary;
  let newLife = false;
  if (isNewLife(previousSummary, summary)) {
    newLife = true;
    record.snapshots = [];
    record.lastSheet = null;
    record.lastInventoryAt = null;
  }

  const skillDelta = computeSkillDelta(record.snapshots, sheet, now);

  const { merged, inventoryMerged } = mergeSections(record.lastSheet, sheet, sections);
  record.lastSheet = merged;
  record.lastSheetAt = now;
  if (inventoryMerged) record.lastInventoryAt = now;

  if (sheet.skills && sections.includes("skills") && !sheet.sectionErrors?.skills) {
    const { levels, xp } = levelsAndXp(sheet);
    const last = record.snapshots.at(-1);
    const levelChanged =
      !last || Object.entries(levels).some(([perkId, level]) => last.levels?.[perkId] !== level);
    if (!last || now - last.at >= CHARACTER_STORE_LIMITS.snapshotMinGapMs || levelChanged) {
      const snapshot = {
        at: now,
        source: SNAPSHOT_SOURCES.has(source) ? source : "view",
        levels,
        xp,
      };
      if (typeof summary?.hoursSurvived === "number") snapshot.hoursSurvived = summary.hoursSurvived;
      if (typeof summary?.zombieKills === "number") snapshot.zombieKills = summary.zombieKills;
      record.snapshots.push(snapshot);
      if (record.snapshots.length > CHARACTER_STORE_LIMITS.maxSnapshots) {
        record.snapshots.splice(0, record.snapshots.length - CHARACTER_STORE_LIMITS.maxSnapshots);
      }
    }
  }

  let serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > CHARACTER_STORE_LIMITS.maxBytes && record.lastSheet?.inventory) {
    delete record.lastSheet.inventory;
    record.lastInventoryAt = null;
    serialized = JSON.stringify(record);
  }
  return { serialized, skillDelta, newLife };
}

/**
 * Merge a freshly read sheet into the player's record and write it back.
 * `sections` are the sections that fetch asked for: an inventory-only fetch
 * updates only the inventory.
 *
 * @returns {Promise<{ record: object, skillDelta: object|null, newLife: boolean } | null>}
 *   null when the server id or username can't be stored.
 */
export async function recordCharacterSheet(serverId, username, sheet, { source = "view", sections = [], now = Date.now() } = {}) {
  const file = characterRecordPath(serverId, username);
  if (!file || !sheet || typeof sheet !== "object") return null;
  return withFileLock(file, async () => {
    const record = readRecordFile(file) ?? emptyRecord(serverId, username);
    record.username = sheet.username ?? record.username ?? username;
    record.serverId = serverId;
    const { serialized, skillDelta, newLife } = applySheet(record, sheet, { source, sections, now });
    // codeql[js/path-injection] file comes from characterRecordPath(): <dataDir>/character-sheets/<serverId>/<hex>.json, where serverId passed ^[A-Za-z0-9_-]{1,64}$ and the name is a sha256 hex digest.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, serialized, { encoding: "utf8", mode: 0o600 });
    return { record, skillDelta, newLife };
  });
}

/**
 * Drop records not updated for `maxAgeDays`, then empty server folders.
 * Runs at boot; never throws.
 */
export async function pruneCharacterStore({ maxAgeDays = 180, now = Date.now() } = {}) {
  const root = storeRoot();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let serverDirs;
  try {
    serverDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const dirent of serverDirs) {
    if (!dirent.isDirectory() || !SERVER_ID_RE.test(dirent.name)) continue;
    const dir = path.join(root, dirent.name);
    try {
      // codeql[js/path-injection] dir is <dataDir>/character-sheets/<name> where name is one of that folder's own entries and matched ^[A-Za-z0-9_-]{1,64}$.
      for (const fileName of fs.readdirSync(dir)) {
        if (!RECORD_FILE_RE.test(fileName)) continue;
        const file = path.join(dir, fileName);
        try {
          // codeql[js/path-injection] file is a <32 hex>.json entry listed from the store's own server folder above.
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.unlinkSync(file);
            removed += 1;
          }
        } catch {
          /* a file that vanished or can't be read is left for the next boot */
        }
      }
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (error) {
      log.debug(`Character store prune skipped a folder: ${error.message}`);
    }
  }
  if (removed > 0) log.info(`Removed ${removed} character record(s) older than ${maxAgeDays} days`);
  return { removed };
}
