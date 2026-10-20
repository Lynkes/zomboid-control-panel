// Suggested mod groups: groups an admin with a long mod list would likely
// make, read off the active server's enabled mods and the mod.info data the
// panel already reads (require= lines, display names, owning Workshop item).
//
//   - dependency:    a library mod required by at least 2 other enabled mods,
//                    plus those mods (library first, then the dependents in
//                    load order); 3 to 60 mods.
//   - workshop-item: one Workshop item that ships 4 or more enabled mod IDs.
//   - prefix:        3 or more enabled mods whose display name starts with
//                    the same distinctive word or bracket tag ("KI5",
//                    "[KI5]", "Brita's", "Authentic Z", ...), generic words
//                    and build tags left out.
//
// Pure and deterministic (same input, same suggestions in the same order),
// and bounded: every loop is linear in the capped input, so a server with
// thousands of mods answers in milliseconds. A suggestion's key is a hash of
// its kind and sorted member IDs, so it stays the same while the member set
// does (a dismissal sticks) and changes when a mod joins or leaves.

import crypto from "crypto";
import { MOD_GROUP_LIMITS } from "./modGroups.js";

export const MOD_GROUP_SUGGESTION_LIMITS = Object.freeze({
  // Work caps: enabled mods looked at, require= entries per mod, name length.
  maxMods: 3000,
  maxRequires: 100,
  maxNameLength: 200,
  dependencyMin: 3,
  dependencyMax: 60,
  workshopItemMin: 4,
  prefixMin: 3,
  // Suggestions answered, after the exclusions.
  maxSuggestions: 50,
  // Words of a shared name prefix kept for the suggested group name.
  prefixNameWords: 4,
});

const KIND_ORDER = ["dependency", "workshop-item", "prefix"];
const KEY_PATTERN = /^(dependency|workshop-item|prefix)-[0-9a-f]{16}$/;

/** The stable key of a suggestion: its kind and a hash of its sorted member IDs. */
export function suggestionKey(kind, modIds) {
  const sorted = [...new Set(modIds)].sort();
  const hash = crypto
    .createHash("sha256")
    .update(`${kind}\n${sorted.join("\n")}`)
    .digest("hex")
    .slice(0, 16);
  return `${kind}-${hash}`;
}

/** True for a string shaped like a key suggestionKey() makes. */
export function isSuggestionKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

// ───── Name prefixes ───────────────────────────────────────────────────────

// Words that start the names of unrelated mods by different authors, so they
// say nothing about which mods belong together. Compared in lower case, with
// a possessive "'s" removed.
const GENERIC_WORDS = new Set([
  // articles, prepositions, conjunctions (en, plus the common es/fr/de/pt)
  "a", "an", "the", "my", "your", "our", "of", "and", "or", "for", "with", "in", "on", "to", "by", "from",
  "el", "la", "le", "les", "los", "las", "de", "des", "du", "der", "die", "das", "und", "o", "os",
  // adjectives and verbs every other mod name starts with
  "more", "better", "best", "new", "simple", "simply", "improved", "extra", "super", "advanced", "realistic",
  "real", "custom", "basic", "less", "no", "not", "fixed", "expanded", "enhanced", "additional", "all", "auto",
  "automatic", "easy", "immersive", "vanilla", "true", "some", "any", "just", "small", "big", "little", "tiny",
  "quick", "smart", "proper", "full", "complete", "ultimate", "original", "classic", "legacy", "old", "modern",
  "awesome", "cool", "useful", "functional", "working", "lootable", "craftable", "craft", "make", "add", "show",
  "hide", "remove", "disable", "enable", "toggle", "fix", "fixes", "patch", "patched", "tweak", "tweaks",
  "rework", "reworked", "overhaul", "update", "updated", "unofficial", "official", "optional", "standalone",
  // what the mod is about, shared by unrelated mods
  "mod", "mods", "modpack", "pack", "addon", "add-on", "addons", "lib", "library", "core", "common", "api",
  "framework", "utils", "utility", "utilities", "tools", "project", "zomboid", "pz", "pzk", "server", "client",
  "mp", "sp", "multiplayer", "singleplayer", "ui", "hud", "map", "maps", "vehicle", "vehicles", "car", "cars",
  "truck", "trucks", "weapon", "weapons", "gun", "guns", "item", "items", "clothing", "clothes", "food",
  "foods", "zombie", "zombies", "survivor", "survivors", "trait", "traits", "skill", "skills", "recipe",
  "recipes", "loot", "building", "buildings", "furniture", "music", "sound", "sounds", "spawn", "spawns",
  "occupation", "occupations", "profession", "professions", "farming", "fishing", "cooking", "medical",
  // release tags
  "wip", "beta", "alpha", "test", "testing", "dev", "experimental", "unstable", "stable", "outdated",
  "deprecated", "obsolete", "fork", "reupload", "re-upload", "translation", "translations", "build",
]);

// Build and version tags: "B42", "42", "42.13", "Build 42", "B41+", "v2".
const VERSION_TAG = /^(?:b|build\s*|v)?\d+(?:[._]\d+)*\+?$/i;

const BRACKET_TAG = /^[\[({]([^\])}]{1,40})[\])}]\s*/;

function stripWordPunctuation(word) {
  return word.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}'’]+$/u, "").replace(/['’]+$/, "");
}

function wordsOf(text) {
  return text
    .split(/\s+/)
    .map(stripWordPunctuation)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

// The grouping key of a first word or tag: lower case, possessive dropped.
function tokenKey(token) {
  return token
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]s$/, "")
    .replace(/['’]+$/, "")
    .trim();
}

function isGenericToken(token) {
  const key = tokenKey(token);
  return key.length < 2 || VERSION_TAG.test(key) || GENERIC_WORDS.has(key) || !/\p{L}/u.test(key);
}

/**
 * The words a mod name is compared by, the first one being its distinctive
 * token (a bracket tag counts as one word), or null when the name starts with
 * a generic word. Leading build tags like "[B42]" are skipped.
 */
export function namePrefixWords(name) {
  if (typeof name !== "string") return null;
  let rest = name.slice(0, MOD_GROUP_SUGGESTION_LIMITS.maxNameLength).trim();
  for (let tags = 0; tags < 3; tags++) {
    const match = rest.match(BRACKET_TAG);
    if (!match) break;
    rest = rest.slice(match[0].length);
    const tag = match[1].trim();
    if (!isGenericToken(tag)) return [tag, ...wordsOf(rest)];
  }
  const words = wordsOf(rest);
  if (words.length === 0 || isGenericToken(words[0])) return null;
  return words;
}

// The suggested name for a prefix cluster: the words every member's name
// starts with (the first word as most members write it), at most a few.
function sharedPrefixName(wordLists) {
  const firstForms = new Map();
  for (const words of wordLists) firstForms.set(words[0], (firstForms.get(words[0]) || 0) + 1);
  let first = wordLists[0][0];
  for (const [form, count] of firstForms) {
    if (count > firstForms.get(first)) first = form;
  }
  const name = [first];
  for (let i = 1; i < MOD_GROUP_SUGGESTION_LIMITS.prefixNameWords; i++) {
    const word = wordLists[0][i];
    if (word === undefined) break;
    const lower = word.toLowerCase();
    if (!wordLists.every((words) => words[i] !== undefined && words[i].toLowerCase() === lower)) break;
    name.push(word);
  }
  return name.join(" ");
}

// ───── Suggestions ─────────────────────────────────────────────────────────

function groupName(text, fallback) {
  const name = String(text || "").trim() || fallback;
  return name.length > MOD_GROUP_LIMITS.nameMax ? name.slice(0, MOD_GROUP_LIMITS.nameMax).trimEnd() : name;
}

/**
 * @param {object} input
 * @param {string[]} input.enabled  the Mods= IDs in load order
 * @param {Array<{id: string, name?: string, workshopId?: string, require?: string[]}>} input.mods
 *        what mod.info says about the mods of the listed Workshop items (the
 *        first entry for an ID wins)
 * @param {Array<{modIds: string[]}>} [input.groups]  the stored groups
 * @param {string[]} [input.dismissed]  dismissed suggestion keys
 * @param {Record<string, string>} [input.workshopTitles]  Workshop item titles by id
 * @returns {Array<{key, kind, name, modIds, reason}>}
 */
export function computeGroupSuggestions({ enabled, mods, groups = [], dismissed = [], workshopTitles = {} }) {
  const L = MOD_GROUP_SUGGESTION_LIMITS;

  // Enabled IDs, first position wins, capped.
  const position = new Map();
  for (const id of Array.isArray(enabled) ? enabled : []) {
    if (position.size >= L.maxMods) break;
    if (typeof id === "string" && id && !position.has(id)) position.set(id, position.size);
  }
  const byLoadOrder = (a, b) => position.get(a) - position.get(b);

  // What is known about each enabled mod.
  const info = new Map();
  for (const mod of Array.isArray(mods) ? mods : []) {
    if (!mod || typeof mod.id !== "string" || !position.has(mod.id) || info.has(mod.id)) continue;
    info.set(mod.id, mod);
  }

  const candidates = [];
  const add = (kind, name, modIds, reason) => {
    candidates.push({ kind, name, modIds: modIds.slice(0, MOD_GROUP_LIMITS.modIdsMax), reason });
  };

  // dependency: library -> the enabled mods that require it.
  const requiredBy = new Map();
  for (const [id, mod] of info) {
    const requires = Array.isArray(mod.require) ? mod.require.slice(0, L.maxRequires) : [];
    for (const lib of new Set(requires)) {
      if (typeof lib !== "string" || lib === id || !position.has(lib)) continue;
      if (!requiredBy.has(lib)) requiredBy.set(lib, []);
      requiredBy.get(lib).push(id);
    }
  }
  for (const lib of [...requiredBy.keys()].sort(byLoadOrder)) {
    const dependents = requiredBy.get(lib).sort(byLoadOrder);
    const size = dependents.length + 1;
    if (dependents.length < 2 || size < L.dependencyMin || size > L.dependencyMax) continue;
    add(
      "dependency",
      groupName(info.get(lib)?.name, lib),
      [lib, ...dependents],
      `library required by ${dependents.length} enabled mods`,
    );
  }

  // workshop-item: one item, 4+ enabled mod IDs.
  const byItem = new Map();
  for (const [id, mod] of info) {
    const wsId = typeof mod.workshopId === "string" ? mod.workshopId : null;
    if (!wsId) continue;
    if (!byItem.has(wsId)) byItem.set(wsId, []);
    byItem.get(wsId).push(id);
  }
  for (const ids of byItem.values()) ids.sort(byLoadOrder);
  for (const [wsId, ids] of [...byItem].sort((a, b) => byLoadOrder(a[1][0], b[1][0]))) {
    if (ids.length < L.workshopItemMin) continue;
    const lists = ids.map((id) => namePrefixWords(info.get(id).name)).filter(Boolean);
    const shared = lists.length === ids.length ? sharedPrefixName(lists) : null;
    add(
      "workshop-item",
      groupName(workshopTitles[wsId] || shared || info.get(ids[0]).name, `Workshop item ${wsId}`),
      ids,
      `${ids.length} enabled mods from Workshop item ${wsId}`,
    );
  }

  // prefix: 3+ enabled mods whose names start with the same distinctive token.
  const clusters = new Map();
  for (const id of [...info.keys()].sort(byLoadOrder)) {
    const words = namePrefixWords(info.get(id).name);
    if (!words) continue;
    const key = tokenKey(words[0]);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push({ id, words });
  }
  for (const members of clusters.values()) {
    if (members.length < L.prefixMin) continue;
    const name = sharedPrefixName(members.map((m) => m.words));
    add("prefix", groupName(name, members[0].words[0]), members.map((m) => m.id), `${members.length} enabled mods named "${name}"`);
  }

  // One suggestion per member set (dependency, then workshop-item, then
  // prefix), none inside an existing group, none dismissed.
  const groupsOf = new Map();
  (Array.isArray(groups) ? groups : []).forEach((group, index) => {
    for (const id of Array.isArray(group?.modIds) ? group.modIds : []) {
      if (!groupsOf.has(id)) groupsOf.set(id, new Set());
      groupsOf.get(id).add(index);
    }
  });
  const insideAGroup = (ids) => {
    let common = null;
    for (const id of ids) {
      const owners = groupsOf.get(id);
      if (!owners) return false;
      common = common ? new Set([...common].filter((g) => owners.has(g))) : new Set(owners);
      if (common.size === 0) return false;
    }
    return true;
  };
  const dismissedKeys = new Set(Array.isArray(dismissed) ? dismissed : []);
  const seenSets = new Set();
  const suggestions = [];
  for (const kind of KIND_ORDER) {
    for (const candidate of candidates.filter((c) => c.kind === kind)) {
      const signature = [...candidate.modIds].sort().join("\n");
      if (seenSets.has(signature)) continue;
      seenSets.add(signature);
      if (insideAGroup(candidate.modIds)) continue;
      const key = suggestionKey(kind, candidate.modIds);
      if (dismissedKeys.has(key)) continue;
      suggestions.push({ key, ...candidate });
    }
  }

  suggestions.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      b.modIds.length - a.modIds.length ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return suggestions.slice(0, L.maxSuggestions);
}
