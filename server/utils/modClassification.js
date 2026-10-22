// What kind of mod each enabled mod is, so the load-order planner can explain
// itself and, when asked for a tiered order, put libraries first and
// translations last. Pure and deterministic: everything it reads is passed in.
//
// Kinds and the tier each one gets (lower loads earlier in a tiered order):
//   library, framework  0  other mods build on it
//   map, content        1  adds maps, items, vehicles, models ...
//   ui, unknown         2  interface mods; no signal at all
//   patch, tweak        3  changes another mod (or the game) on purpose
//   translation         4  translations merge key by key and the LATER mod
//                          wins, so they belong after what they translate
//
// Signals, strongest first (the first that applies decides; reasons list why):
//   1. what the mod's loaded folders hold (utils/modContentProfile.js): only
//      Translate files -> translation; a media/maps/<folder> with map data ->
//      map; only Lua (and translations) that overrides files of the mods it
//      requires -> patch of those mods
//   2. how many enabled mods require it (3 or more -> library, framework when
//      Steam tags or names it so)
//   3. require=/loadModAfter= on another mod plus a patch-like name or ID
//      ("patch", "fix", "compat", "addon", "tweak", "hotfix", "integration",
//      "for <X>", "<X> - ...") -> patch of that mod
//   4. Steam Workshop tags (Framework, Map, Language/Translation, Interface,
//      QoL, Vehicles ...)
//   5. name/ID keywords (lib, library, framework, api, utils -> library; core,
//      base, common only with dependents)

export const MOD_KINDS = Object.freeze([
  "library",
  "framework",
  "map",
  "translation",
  "patch",
  "content",
  "tweak",
  "ui",
  "unknown",
]);

export const KIND_TIER = Object.freeze({
  library: 0,
  framework: 0,
  map: 1,
  content: 1,
  ui: 2,
  unknown: 2,
  patch: 3,
  tweak: 3,
  translation: 4,
});

export const CLASSIFICATION_LIMITS = Object.freeze({
  maxMods: 5000,
  maxListEntries: 200,
  maxNameLength: 200,
  manyDependents: 3,
  // "Small" for a Lua-only tweak.
  smallModFiles: 15,
});

function words(value) {
  return ` ${String(value || "")
    .slice(0, CLASSIFICATION_LIMITS.maxNameLength)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()} `;
}

function hasWord(text, list) {
  for (const word of list) if (text.includes(` ${word} `)) return true;
  return false;
}

const PATCH_WORDS = [
  "patch",
  "patches",
  "patched",
  "fix",
  "fixes",
  "hotfix",
  "compat",
  "compatibility",
  "addon",
  "addons",
  "add on",
  "tweak",
  "tweaks",
  "integration",
  "support",
  "bridge",
];
const LIBRARY_STRONG_WORDS = ["lib", "libs", "library", "libraries", "framework", "api", "utils", "util", "utilities", "toolkit"];
const LIBRARY_WEAK_WORDS = ["core", "base", "common", "shared"];
const UI_WORDS = ["ui", "hud", "interface", "menu", "menus", "tooltip", "tooltips", "minimap", "icons"];
const TWEAK_WORDS = [
  "tweak",
  "tweaks",
  "qol",
  "rebalance",
  "rebalanced",
  "balance",
  "balanced",
  "nerf",
  "buff",
  "tuning",
  "adjust",
  "adjustments",
];
// Translation in the languages the Workshop sees most, matched on the raw
// lower-cased name (several are not Latin script).
const TRANSLATION_NAME =
  /translat|traduc|tradu[cç][aã]o|[uü]bersetz|перевод|переклад|翻译|翻譯|中文|日本語|한국어|locali[sz]ation|language pack/i;

const CONTENT_TAGS = new Set([
  "vehicles",
  "weapons",
  "clothing/armor",
  "items",
  "food",
  "models",
  "animals",
  "building",
  "literature",
  "traits",
  "skills",
  "military",
  "pop culture",
  "farming",
  "audio",
  "textures",
]);
const TWEAK_TAGS = new Set(["qol", "balance", "hardmode", "realistic"]);

function asList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= CLASSIFICATION_LIMITS.maxListEntries) break;
  }
  return out;
}

function tagsFor(steamTags, workshopId) {
  if (!steamTags || !workshopId) return new Set();
  const list = steamTags instanceof Map ? steamTags.get(workshopId) : steamTags[workshopId];
  return new Set(asList(list).map((t) => t.toLowerCase()));
}

// How plainly a mod's name points at the mod it builds on:
//   2  "Patch for Brita's Weapons", "Brita's Weapons - Patch" (a patch word
//      after the separator)
//   1  "Brita's Weapons - Armor", or its id/name contains the target's id
//   0  not at all
function namesTarget(patch, target) {
  const patchName = String(patch.name || "").slice(0, CLASSIFICATION_LIMITS.maxNameLength).toLowerCase().trim();
  const patchWords = words(`${patch.name || ""} ${patch.id}`);
  const targetName = String(target.name || "").slice(0, CLASSIFICATION_LIMITS.maxNameLength).trim().toLowerCase();
  const targetWords = words(target.name).trim();
  const targetIdWords = words(target.id).trim();
  if (targetName.length >= 3 && patchName.includes(`for ${targetName}`)) return 2;
  if (targetWords.length >= 4 && patchWords.includes(` for ${targetWords} `)) return 2;
  if (targetName.length >= 3 && patchName.startsWith(targetName)) {
    const rest = patchName.slice(targetName.length);
    if (/^\s*(?:[-–—:|]|\()/.test(rest) && rest.replace(/[\s\-–—:|()]+/g, "").length > 0) {
      return hasWord(words(rest), PATCH_WORDS) ? 2 : 1;
    }
  }
  if (targetIdWords.length >= 4 && targetIdWords !== words(patch.id).trim() && patchWords.includes(` ${targetIdWords} `)) {
    return 1;
  }
  return 0;
}

function reason(code, params) {
  return params ? { code, params } : { code };
}

/**
 * Classifies the enabled mods.
 *
 * @param {object} input
 * @param {Array} input.mods  every known mod: { id, name?, workshopId?,
 *        require?, loadAfter?, loadBefore?, profile? } (profile from
 *        utils/modContentProfile.js; null/absent when the folder was not read)
 * @param {string[]} input.enabled  the ids that load (the effective order);
 *        only these are classified, and dependents are counted among them
 * @param {object|Map} [input.steamTags]  Workshop tags by Workshop id
 * @param {Array} [input.namePatches]  [{ before: target, after: patch }]:
 *        computeOrderingConstraints()'s name-only `patch` edges
 * @returns {Map<string, { kind, confidence, reasons, tier, patchOf,
 *          dependents, requiredBy, requires }>}
 */
export function classifyMods({ mods, enabled, steamTags = null, namePatches = [] }) {
  const catalog = new Map();
  for (const mod of Array.isArray(mods) ? mods : []) {
    if (catalog.size >= CLASSIFICATION_LIMITS.maxMods) break;
    if (mod && typeof mod.id === "string" && mod.id && !catalog.has(mod.id)) catalog.set(mod.id, mod);
  }
  const enabledIds = [];
  const enabledSet = new Set();
  for (const id of Array.isArray(enabled) ? enabled : []) {
    if (typeof id === "string" && id && !enabledSet.has(id) && enabledSet.size < CLASSIFICATION_LIMITS.maxMods) {
      enabledSet.add(id);
      enabledIds.push(id);
    }
  }

  // Who requires whom, among the enabled mods.
  const requires = new Map();
  const requiredBy = new Map(enabledIds.map((id) => [id, []]));
  for (const id of enabledIds) {
    const list = asList(catalog.get(id)?.require).filter((dep) => dep !== id);
    requires.set(id, list);
    for (const dep of list) if (requiredBy.has(dep)) requiredBy.get(dep).push(id);
  }
  // What each mod declares it builds on: require=, loadModAfter=, and the
  // mods whose loadModBefore= names it.
  const buildsOn = new Map(enabledIds.map((id) => [id, new Set()]));
  for (const id of enabledIds) {
    const mod = catalog.get(id);
    for (const dep of [...asList(mod?.require), ...asList(mod?.loadAfter)]) {
      if (dep !== id && enabledSet.has(dep)) buildsOn.get(id).add(dep);
    }
    for (const next of asList(mod?.loadBefore)) {
      if (next !== id && enabledSet.has(next)) buildsOn.get(next).add(id);
    }
  }
  const nameTargets = new Map();
  for (const edge of Array.isArray(namePatches) ? namePatches : []) {
    if (!edge || !enabledSet.has(edge.before) || !enabledSet.has(edge.after) || edge.before === edge.after) continue;
    if (!nameTargets.has(edge.after)) nameTargets.set(edge.after, new Set());
    nameTargets.get(edge.after).add(edge.before);
  }

  const result = new Map();
  for (const id of enabledIds) {
    const mod = catalog.get(id) || { id };
    const profile = mod.profile || null;
    const tags = tagsFor(steamTags, mod.workshopId);
    const nameWords = words(`${mod.name || ""} ${id}`);
    const idWords = words(id);
    const dependents = requiredBy.get(id) || [];
    const targets = [...(buildsOn.get(id) || [])];
    const verdict = decide({
      mod,
      profile,
      tags,
      nameWords,
      idWords,
      dependents,
      targets,
      catalog,
      nameTargets: nameTargets.get(id),
    });
    result.set(id, {
      kind: verdict.kind,
      confidence: verdict.confidence,
      reasons: verdict.reasons,
      tier: KIND_TIER[verdict.kind],
      patchOf: verdict.patchOf || [],
      dependents: dependents.length,
      requiredBy: dependents,
      requires: requires.get(id) || [],
    });
  }
  return result;
}

function decide({ mod, profile, tags, nameWords, idWords, dependents, targets, catalog, nameTargets }) {
  const rawName = String(mod.name || "").slice(0, CLASSIFICATION_LIMITS.maxNameLength).toLowerCase();
  const gameplayFiles = profile ? profile.files : 0;

  // 1a. Only translation files.
  if (profile && gameplayFiles > 0 && profile.translation === gameplayFiles) {
    return {
      kind: "translation",
      confidence: profile.translationJson === profile.translation ? "high" : "medium",
      reasons: [reason("translationFilesOnly", { files: profile.translation })],
    };
  }
  // 1b. Map data in a loaded media/maps folder.
  if (profile && profile.mapFolders.length > 0) {
    return { kind: "map", confidence: "high", reasons: [reason("mapFolder", { folders: profile.mapFolders.slice(0, 10) })] };
  }
  // 2. Many enabled mods build on it.
  if (dependents.length >= CLASSIFICATION_LIMITS.manyDependents) {
    const framework = tags.has("framework") || hasWord(nameWords, ["framework"]);
    const reasons = [reason("manyDependents", { count: dependents.length })];
    if (tags.has("framework")) reasons.push(reason("steamTag", { tag: "Framework" }));
    return { kind: framework ? "framework" : "library", confidence: "high", reasons };
  }
  // 1c. Only Lua (and translations) overriding files of the mods it builds on.
  if (profile && profile.lua > 0 && targets.length > 0 && !profile.luaPathsTruncated) {
    const otherFiles = gameplayFiles - profile.lua - profile.translation - (profile.sandboxOptions ? 1 : 0);
    if (otherFiles === 0) {
      const covered = new Set();
      const patchOf = [];
      for (const targetId of targets) {
        const targetProfile = catalog.get(targetId)?.profile;
        if (!targetProfile || targetProfile.luaPathsTruncated) continue;
        const theirs = new Set(targetProfile.luaPaths);
        let hit = false;
        for (const luaPath of profile.luaPaths) {
          if (theirs.has(luaPath)) {
            covered.add(luaPath);
            hit = true;
          }
        }
        if (hit) patchOf.push(targetId);
      }
      if (patchOf.length > 0 && covered.size === profile.luaPaths.length) {
        return {
          kind: "patch",
          confidence: "high",
          reasons: [reason("overridesRequiredLua", { targets: patchOf, files: covered.size })],
          patchOf,
        };
      }
    }
  }
  // 3. Declares a mod it builds on and is named like a patch of it.
  if (targets.length > 0) {
    const levels = targets.map((targetId) => namesTarget(mod, catalog.get(targetId) || { id: targetId }));
    const best = Math.max(...levels);
    const patchWord = hasWord(nameWords, PATCH_WORDS);
    if (best > 0 || patchWord) {
      const named = targets.filter((_, i) => levels[i] === best && best > 0);
      const patchOf = named.length > 0 ? named : targets;
      const high = best === 2 || (best === 1 && patchWord);
      return {
        kind: "patch",
        confidence: high ? "high" : "medium",
        reasons: [reason(named.length > 0 ? "namedForTarget" : "patchNamed", { targets: patchOf.slice(0, 10) })],
        patchOf,
      };
    }
  }
  // 4. Steam tags and names.
  if (tags.has("language/translation") || TRANSLATION_NAME.test(rawName)) {
    const mostlyTranslations = profile ? profile.translation > 0 && profile.translation * 2 >= gameplayFiles : true;
    if (mostlyTranslations) {
      return {
        kind: "translation",
        confidence: profile ? "medium" : "low",
        reasons: [tags.has("language/translation") ? reason("steamTag", { tag: "Language/Translation" }) : reason("translationName")],
      };
    }
  }
  if (tags.has("framework")) {
    return {
      kind: "framework",
      confidence: dependents.length > 0 ? "high" : "medium",
      reasons: [reason("steamTag", { tag: "Framework" }), ...(dependents.length ? [reason("dependents", { count: dependents.length })] : [])],
    };
  }
  if (tags.has("map") && !profile) {
    return { kind: "map", confidence: "low", reasons: [reason("steamTag", { tag: "Map" })] };
  }
  if (hasWord(idWords, LIBRARY_STRONG_WORDS) || hasWord(nameWords, LIBRARY_STRONG_WORDS)) {
    return {
      kind: hasWord(nameWords, ["framework"]) ? "framework" : "library",
      confidence: dependents.length > 0 ? "medium" : "low",
      reasons: [reason("libraryName"), ...(dependents.length ? [reason("dependents", { count: dependents.length })] : [])],
    };
  }
  if (dependents.length > 0 && hasWord(idWords, LIBRARY_WEAK_WORDS)) {
    return {
      kind: "library",
      confidence: "medium",
      reasons: [reason("libraryName"), reason("dependents", { count: dependents.length })],
    };
  }
  if (tags.has("interface")) {
    return { kind: "ui", confidence: "medium", reasons: [reason("steamTag", { tag: "Interface" })] };
  }
  // Code only: Lua (with its translations, sandbox options, UI images and a
  // few icons), no scripts, maps, models, clothing or sounds.
  const luaOnly =
    profile &&
    profile.lua > 0 &&
    profile.scripts + profile.maps + profile.models + profile.clothing + profile.audio === 0 &&
    profile.textures <= 10;
  if (luaOnly && profile.luaClient === profile.lua && hasWord(nameWords, UI_WORDS)) {
    return { kind: "ui", confidence: "low", reasons: [reason("clientLuaOnly"), reason("uiName")] };
  }
  if (nameTargets && nameTargets.size > 0) {
    return {
      kind: "patch",
      confidence: "low",
      reasons: [reason("patchNameOnly", { targets: [...nameTargets].slice(0, 10) })],
      patchOf: [...nameTargets],
    };
  }
  const tweakTag = [...tags].find((t) => TWEAK_TAGS.has(t));
  const contentTag = [...tags].find((t) => CONTENT_TAGS.has(t));
  const hasContentFiles = profile && (profile.scripts > 0 || profile.models > 0 || profile.clothing > 0);
  if (tweakTag && !hasContentFiles) {
    return { kind: "tweak", confidence: "medium", reasons: [reason("steamTag", { tag: tweakTag })] };
  }
  if (profile && profile.scripts > 0) {
    const reasons = [reason("scriptsContent", { files: profile.scripts })];
    if (contentTag) reasons.push(reason("steamTag", { tag: contentTag }));
    return { kind: "content", confidence: contentTag ? "high" : "medium", reasons };
  }
  if (hasWord(nameWords, TWEAK_WORDS) && (!profile || luaOnly)) {
    return { kind: "tweak", confidence: "low", reasons: [reason("tweakName")] };
  }
  if (luaOnly && gameplayFiles <= CLASSIFICATION_LIMITS.smallModFiles && dependents.length === 0) {
    return { kind: "tweak", confidence: "low", reasons: [reason("smallLuaOnly", { files: gameplayFiles })] };
  }
  if (profile && profile.models + profile.textures + profile.audio + profile.clothing > 0) {
    const reasons = [reason("assetsContent")];
    if (contentTag) reasons.push(reason("steamTag", { tag: contentTag }));
    return { kind: "content", confidence: contentTag ? "medium" : "low", reasons };
  }
  if (contentTag) {
    return { kind: "content", confidence: "low", reasons: [reason("steamTag", { tag: contentTag })] };
  }
  if (luaOnly) {
    return { kind: "tweak", confidence: "low", reasons: [reason("luaOnly")] };
  }
  return { kind: "unknown", confidence: "low", reasons: [reason("noSignal")] };
}
