// How Project Zomboid Build 42 really orders and loads mods, as a pure model the
// Mods page and the conflict scanner share.
//
// GROUND TRUTH (read from projectzomboid.jar of 42.21 with javap, and run with
// a reflection harness against the game's own classes on fake mod folders):
//
// mod.info -- zombie.gameStates.ChooseGameInfo.readModInfoAux
//   * The game reads ONE mod.info: <mod>/<versionDir>/mod.info, else
//     <mod>/common/mod.info. A root <mod>/mod.info (the B41 layout) is never
//     read: such a folder is not a B42 mod at all
//     (ZomboidFileSystem.getAllModFoldersAux only lists folders with
//     common/mod.info or <versionDir>/mod.info).
//   * <versionDir> is ZomboidFileSystem.getModVersionDirName: the highest
//     child folder named like a game version ("42", "42.5", "42.13.1": major *
//     1000 + min(minor, 999)) that is >= 42.0 and <= the running game version;
//     "42.0" when there is none. The minor part must be a plain integer.
//   * Lines are tested in a fixed if/else order with String.contains:
//     name=, poster=, description=, require=, incompatible=, loadModAfter=,
//     loadModBefore=, then id= (startsWith, trimmed), author=, modversion=,
//     icon=, category=, url=, pack=, tiledef=, versionMax=, versionMin=
//     (startsWith). Keys are case-sensitive: "Require=" or "require = x" is
//     ignored.
//   * require=, incompatible=, loadModAfter=, loadModBefore= all become
//     line.replace(key, "").replace("\\", "").split(","): every backslash is
//     removed, entries are split on "," ONLY (a ";" stays inside one entry),
//     surrounding whitespace is KEPT, trailing empty entries are dropped (Java
//     split), a value of nothing becomes one empty entry, and the last such
//     line wins. Mod ids are case-sensitive everywhere.
//
// Load order -- zombie.network.GameServer (Mods=) and
// ZomboidFileSystem.loadMods / loadModAndRequired / loadModsAux
//   * Mods= loses every backslash, is split on ";" and each entry trimmed.
//   * The server loads the list in that order, depth first: before a mod it
//     loads each require= entry (recursively, in the order written), even one
//     that is not in Mods= at all. A mod already loaded is skipped.
//   * A mod is loaded only when it is "available" (Mod.isAvailable): versionMin
//     / versionMax admit the running game, and every require= entry, trimmed,
//     names a mod that exists and is itself available (recursively). A missing
//     entry (wrong case, a typo, "A;B", an empty or blank entry such as
//     "require=" with nothing after it or "A,,B") makes the mod unavailable:
//     it is skipped and removed from the server's mod list.
//   * The require= entries are then loaded UNTRIMMED, so "require=\A, \B"
//     looks up " B", finds nothing, and the mod is not loaded either.
//   * A require= cycle (A needs B, B needs A) recurses until the JVM throws
//     StackOverflowError while the server loads its mods.
//   * loadModAfter=, loadModBefore= and incompatible= are NOT used by the
//     server at all: only the main menu's mod selector (Lua,
//     ModLoadOrderPanel / ModSelectorModel) reads them, to colour and
//     "Auto"-sort the list (loadModAfter + require before, loadModBefore
//     after) and to flag incompatible pairs (in both directions).
//
// Files -- ZomboidFileSystem.loadMod, LuaManager.LoadDirBase,
// ScriptManager.Load, Translator.tryFillMapFromMods, OutfitManager,
// CustomSandboxOptions, ZomboidFileSystem.loadFileGuidTable
//   * Every file under common/ then <versionDir>/ of each mod, in load order,
//     goes into one map keyed by its lower-cased path relative to that
//     folder: the LAST mod wins a path, and within a mod <versionDir> beats
//     common/. The game logs "mod X overrides <path>" for each one.
//   * Lua (media/lua/shared, then client, then server; a dedicated server only
//     checksums client/): each relative path runs ONCE -- the winner's copy --
//     at the position of its first occurrence (vanilla files first, then each
//     mod's files sorted case-insensitively).
//   * Scripts (media/scripts/**/*.txt): same rule per path (only the winner's
//     copy of a shared path is parsed, the other copies are never read).
//     Definitions are then merged by module + type + name across ALL files:
//     every later body of the same name replaces the earlier one entirely
//     (ScriptType flag ResetExisting), except "vehicle" and "xuiSkin" bodies,
//     which are applied on top of each other (later properties win).
//   * Translations (media/lua/shared/Translate/<LANG>/<Category>.json; .txt
//     files are not read by B42): every mod's own file is read, common/ then
//     <versionDir>/, and merged key by key: a later non-empty value replaces
//     the earlier one, an empty value never does. Two mods shipping the same
//     file name is harmless; only the same key with different values is.
//   * clothing/clothing.xml: each mod's own file (<versionDir>, else common/)
//     is merged outfit by outfit (male and female lists), a later outfit of
//     the same name replacing the earlier. clothingItems/*.xml load through
//     the path map (last wins). sandbox-options.txt and fileGuidTable.xml are
//     read per mod and merged entry by entry.

/** Java's String.split(",") for a literal one-character separator. */
function javaSplit(value, separator) {
  if (value === "") return [""];
  const parts = value.split(separator);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function listValue(line, key) {
  return javaSplit(line.split(key).join("").split("\\").join(""), ",");
}

const LINE_BREAK = /\r\n|\r|\n/;

// A real mod.info is a few hundred bytes; a Workshop item is someone else's
// content, so only this much of one is read for the ordering fields (the
// same cap as utils/modInfoText.js).
const MOD_INFO_MAX_CHARS = 64 * 1024;

/**
 * The ordering fields of one mod.info, read line by line exactly as
 * ChooseGameInfo.readModInfoAux does. Each list is the game's raw entries
 * (null when the key is absent). A leading BOM is dropped, as the panel's id
 * reader does; only the first 64 KB are read.
 */
export function parseModInfoForGame(content) {
  const result = {
    id: null,
    require: null,
    incompatible: null,
    loadModAfter: null,
    loadModBefore: null,
    category: null,
    versionMin: null,
    versionMax: null,
  };
  let text = String(content ?? "").slice(0, MOD_INFO_MAX_CHARS + 1);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.slice(0, MOD_INFO_MAX_CHARS);
  for (const line of text.split(LINE_BREAK)) {
    if (line.includes("name=")) continue;
    if (line.includes("poster=")) continue;
    if (line.includes("description=")) continue;
    if (line.includes("require=")) {
      result.require = listValue(line, "require=");
    } else if (line.includes("incompatible=")) {
      result.incompatible = listValue(line, "incompatible=");
    } else if (line.includes("loadModAfter=")) {
      result.loadModAfter = listValue(line, "loadModAfter=");
    } else if (line.includes("loadModBefore=")) {
      result.loadModBefore = listValue(line, "loadModBefore=");
    } else if (line.startsWith("id=")) {
      const id = line.split("id=").join("").trim();
      if (id) result.id = id;
    } else if (
      line.includes("author=") ||
      line.includes("modversion=") ||
      line.includes("icon=")
    ) {
      continue;
    } else if (line.includes("category=")) {
      result.category = line.split("category=").join("");
    } else if (
      line.includes("url=") ||
      line.includes("pack=") ||
      line.includes("tiledef=")
    ) {
      continue;
    } else if (line.startsWith("versionMax=")) {
      const v = line.split("versionMax=").join("").trim();
      if (v) result.versionMax = v;
    } else if (line.startsWith("versionMin=")) {
      const v = line.split("versionMin=").join("").trim();
      if (v) result.versionMin = v;
    }
  }
  return result;
}

const LIST_FIELDS = ["require", "loadModAfter", "loadModBefore", "incompatible"];

/**
 * The ids a raw mod.info list names, as the author meant them: trimmed, a
 * ";"-joined entry split, empty entries and repeats dropped. Every entry the
 * game itself cannot match is reported as an issue:
 *   emptyEntry  "" (e.g. "require=" with nothing, "A,,B")
 *   blankEntry  only whitespace
 *   whitespace  spaces around an id (" B" after "A, ")
 *   semicolon   "A;B" (the game splits on "," only)
 */
export function normaliseModInfoList(raw, field = "require") {
  const ids = [];
  const issues = [];
  if (!Array.isArray(raw)) return { ids, issues };
  const seen = new Set();
  for (const entry of raw) {
    if (entry === "") {
      issues.push({ field, entry, code: "emptyEntry" });
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      issues.push({ field, entry, code: "blankEntry" });
      continue;
    }
    if (trimmed !== entry) issues.push({ field, entry, code: "whitespace" });
    let parts = [trimmed];
    if (trimmed.includes(";")) {
      issues.push({ field, entry: trimmed, code: "semicolon" });
      parts = trimmed.split(";").map((p) => p.trim()).filter(Boolean);
    }
    for (const id of parts) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return { ids, issues };
}

/**
 * Ordering fields for the API: { loadAfter, loadBefore, incompatible,
 * modInfoIssues } from a parseModInfoForGame() result (ids normalised with
 * normaliseModInfoList; issues of all four lists).
 */
export function orderingFieldsFromModInfo(parsed) {
  const out = { loadAfter: [], loadBefore: [], incompatible: [], modInfoIssues: [] };
  if (!parsed) return out;
  for (const field of LIST_FIELDS) {
    const { ids, issues } = normaliseModInfoList(parsed[field], field);
    out.modInfoIssues.push(...issues);
    if (field === "loadModAfter") out.loadAfter = ids;
    else if (field === "loadModBefore") out.loadBefore = ids;
    else if (field === "incompatible") out.incompatible = ids;
  }
  return out;
}

/**
 * ZomboidFileSystem.getGameVersionIntFromName: "42" -> 42000, "42.5" ->
 * 42005, "42.13.1" -> 42013, anything else -> 0.
 */
export function gameVersionIntFromName(name) {
  if (typeof name !== "string") return 0;
  const parts = name.split(".");
  const int = (s) => (/^[+-]?\d+$/.test(s) ? Number.parseInt(s, 10) : 0);
  if (parts.length === 1) return int(parts[0]) * 1000;
  return int(parts[0]) * 1000 + Math.min(int(parts[1]), 999);
}

const MIN_B42_VERSION = 42000;

/**
 * The version folder the game loads from a mod folder's child folder names
 * (getModVersionDirName), or null when none qualifies. Without the server's
 * exact build the newest Build 42 folder is assumed (below 43.0).
 */
export function pickModVersionFolder(folderNames, gameVersionInt = 42999) {
  let best = null;
  let bestVersion = MIN_B42_VERSION;
  for (const name of folderNames || []) {
    const v = gameVersionIntFromName(name);
    if (v >= bestVersion && v <= gameVersionInt) {
      best = name;
      bestVersion = v;
    }
  }
  return best;
}

function toCatalog(mods) {
  const catalog = new Map();
  for (const mod of mods || []) {
    if (mod && typeof mod.id === "string" && mod.id && !catalog.has(mod.id)) catalog.set(mod.id, mod);
  }
  return catalog;
}

// The raw require= entries the game uses for a catalog entry: requireRaw when
// the mod.info was read with parseModInfoForGame, else the panel's own list.
function rawRequire(mod) {
  if (!mod) return null;
  if (Array.isArray(mod.requireRaw)) return mod.requireRaw;
  if (mod.requireRaw === null) return null;
  return Array.isArray(mod.require) && mod.require.length > 0 ? mod.require : null;
}

function trimmedIds(list) {
  return normaliseModInfoList(list).ids;
}

/**
 * The order a dedicated server really loads `modsLine` (the Mods= ids) in,
 * from `mods` (every known mod: { id, require, requireRaw?, loadAfter?,
 * loadBefore?, incompatible? }), modelled on ZomboidFileSystem.loadMods.
 *
 * Returns { order, notLoaded, warnings }:
 *   order      ids in the order the game loads them (required mods first,
 *              including ones missing from Mods=)
 *   notLoaded  [{ modId, missing?, cause }] Mods= entries the game skips
 *   warnings   order warnings (see analyzeModOrder)
 * A Mods= id the panel knows nothing about (not in `mods`) is kept where it
 * is: it may be a local mod the panel cannot see.
 */
export function computeEffectiveModOrder(modsLine, mods) {
  const catalog = toCatalog(mods);
  const order = [];
  const loaded = new Set();
  const notLoaded = new Map();
  const warnings = [];
  const availability = new Map();

  // Mod.isAvailable / isAvailableRequired, with the game's shared visited
  // list (a Set here: same answers, without the game's quadratic lookups on
  // a hostile list). versionMin/versionMax are not checked: the panel does
  // not know the server's exact build.
  function availableRequired(mod, visited) {
    const req = rawRequire(mod);
    if (!req || req.length === 0) return { ok: true };
    for (const entry of req) {
      const id = entry.trim();
      if (visited.has(id)) continue;
      visited.add(id);
      const dep = catalog.get(id);
      if (!dep) return { ok: false, missing: entry, parent: mod.id };
      const nested = availableRequired(dep, visited);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  }
  function isAvailable(mod) {
    if (!availability.has(mod.id)) availability.set(mod.id, availableRequired(mod, new Set([mod.id])));
    return availability.get(mod.id);
  }

  const stack = [];
  function loadModAndRequired(id) {
    if (id === "") return null;
    if (id.toLowerCase() === "examplemod") return null;
    if (loaded.has(id)) return null;
    const mod = catalog.get(id);
    if (!mod) return { missing: id, unknown: true };
    const avail = isAvailable(mod);
    if (!avail.ok) return { missing: avail.missing, parent: avail.parent, unavailable: id };
    const req = rawRequire(mod);
    if (req) {
      if (stack.includes(id)) return { cycle: [...stack.slice(stack.indexOf(id)), id] };
      stack.push(id);
      for (const entry of req) {
        const failure = loadModAndRequired(entry);
        if (failure) {
          stack.pop();
          return failure.parent || failure.cycle ? failure : { ...failure, parent: id };
        }
      }
      stack.pop();
    }
    loaded.add(id);
    order.push(id);
    return null;
  }

  const listed = [];
  const listedSet = new Set();
  for (const id of modsLine || []) {
    if (typeof id !== "string" || !id || listedSet.has(id)) continue;
    listedSet.add(id);
    listed.push(id);
  }

  for (const id of listed) {
    if (loaded.has(id) || id.toLowerCase() === "examplemod") continue;
    if (!catalog.has(id)) {
      // Unknown to the panel: keep its place, the game may well find it.
      loaded.add(id);
      order.push(id);
      warnings.push({ code: "modNotFound", severity: "info", modId: id });
      continue;
    }
    const failure = loadModAndRequired(id);
    if (!failure) continue;
    if (failure.cycle) {
      const cycle = failure.cycle;
      const key = [...new Set(cycle)].sort().join("|");
      if (!warnings.some((w) => w.code === "requireCycle" && w.key === key)) {
        warnings.push({ code: "requireCycle", severity: "high", modId: id, cycle, key });
      }
      notLoaded.set(id, { modId: id, cause: "requireCycle", cycle });
      continue;
    }
    notLoaded.set(id, {
      modId: id,
      cause: failure.unknown ? "requireNotFound" : "requireUnavailable",
      missing: failure.missing,
      via: failure.parent && failure.parent !== id ? failure.parent : undefined,
    });
  }
  for (const w of warnings) delete w.key;
  return { order, notLoaded: [...notLoaded.values()], warnings };
}

// Compatibility patches that do not declare require=/loadModAfter=:
// recognised by name only, and used only where no declared rule applies.
const PATCH_WORDS = /(?:^|\s)(?:patch|patches|patched|compat|compatibility|fix|fixes|hotfix|addon|add on|tweak|tweaks|integration|support|bridge)(?:\s|$)/i;

function words(value) {
  return ` ${String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()} `;
}

function patchProfile(mod) {
  const idWords = words(mod.id);
  const nameWords = words(mod.name);
  return {
    id: mod.id,
    idWords,
    nameWords,
    idKey: idWords.trim(),
    nameKey: nameWords.trim(),
    patchy: PATCH_WORDS.test(`${idWords} ${nameWords}`),
  };
}

function looksLikePatchFor(patch, target) {
  if (!patch.patchy || patch.id === target.id) return false;
  if (target.idKey.length >= 4 && patch.idKey !== target.idKey && patch.idWords.includes(` ${target.idKey} `)) {
    return true;
  }
  return (
    target.nameKey.length >= 6 &&
    target.nameKey.includes(" ") &&
    patch.nameKey !== target.nameKey &&
    patch.nameWords.includes(` ${target.nameKey} `)
  );
}

const REASON_RANK = { require: 0, loadAfter: 1, loadBefore: 1, patch: 2, conflictWinner: 3 };

/**
 * Edges a load-order sort should respect, between the given mods only:
 *   { before, after, reason, reasons?, declaredBy? }
 * `before` must load before `after`. reason is the strongest of:
 *   require        `after` require=s `before` (the game enforces it)
 *   loadAfter      `after` has loadModAfter=`before`
 *   loadBefore     `before` has loadModBefore=`after`
 *   patch          `after` is named as a patch/compat/fix for `before` and
 *                  declares nothing about it (soft)
 *   conflictWinner `after` currently wins a conflict against `before`;
 *                  keeps that winner unless something above says otherwise
 *                  (soft; from options.conflictWinners [{ winner, loser }])
 * `reasons` lists every reason when there are several. Both directions can
 * appear for a pair (a declared cycle); the caller decides.
 */
export function computeOrderingConstraints(mods, options = {}) {
  const catalog = toCatalog(mods);
  const edges = new Map();
  function add(before, after, reason, declaredBy) {
    if (!before || !after || before === after) return;
    if (!catalog.has(before) || !catalog.has(after)) return;
    const key = `${before}\u0000${after}`;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, { before, after, reason, reasons: [reason], declaredBy });
      return;
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (REASON_RANK[reason] < REASON_RANK[existing.reason]) {
      existing.reason = reason;
      existing.declaredBy = declaredBy;
    }
  }
  for (const mod of catalog.values()) {
    for (const dep of trimmedIds(mod.require)) add(dep, mod.id, "require", mod.id);
    for (const dep of mod.loadAfter || []) add(dep, mod.id, "loadAfter", mod.id);
    for (const next of mod.loadBefore || []) add(mod.id, next, "loadBefore", mod.id);
  }
  const related = (a, b) => edges.has(`${a}\u0000${b}`) || edges.has(`${b}\u0000${a}`);
  if (options.patchHeuristic !== false) {
    const profiles = [...catalog.values()].map(patchProfile);
    for (const patch of profiles) {
      if (!patch.patchy) continue;
      for (const target of profiles) {
        if (patch === target || related(patch.id, target.id)) continue;
        if (looksLikePatchFor(patch, target) && !looksLikePatchFor(target, patch)) {
          add(target.id, patch.id, "patch", patch.id);
        }
      }
    }
  }
  for (const { winner, loser } of options.conflictWinners || []) {
    if (related(winner, loser)) continue;
    add(loser, winner, "conflictWinner");
  }
  return [...edges.values()]
    .map((edge) => {
      const out = { before: edge.before, after: edge.after, reason: edge.reason };
      if (edge.reasons.length > 1) out.reasons = edge.reasons.slice().sort((a, b) => REASON_RANK[a] - REASON_RANK[b]);
      if (edge.declaredBy) out.declaredBy = edge.declaredBy;
      return out;
    })
    .sort(
      (a, b) =>
        REASON_RANK[a.reason] - REASON_RANK[b.reason] ||
        a.after.localeCompare(b.after) ||
        a.before.localeCompare(b.before),
    );
}

/**
 * `dependsOn(a, b)`: a declared, directly or through other mods, that it
 * builds on b (a require=s or loadModAfter=s b, or b has loadModBefore=a).
 * A mod that overrides files of something it depends on does it on purpose.
 */
export function createDependencyRelation(mods) {
  const catalog = toCatalog(mods);
  const direct = new Map();
  // Only links between known mods matter (an unknown id leads nowhere), and
  // keeping only those bounds the graph whatever a mod.info lists.
  const link = (from, to) => {
    if (!from || !to || from === to || !catalog.has(from) || !catalog.has(to)) return;
    if (!direct.has(from)) direct.set(from, new Set());
    direct.get(from).add(to);
  };
  for (const mod of catalog.values()) {
    for (const dep of trimmedIds(mod.require)) link(mod.id, dep);
    for (const dep of mod.loadAfter || []) link(mod.id, dep);
    for (const next of mod.loadBefore || []) link(next, mod.id);
  }
  const closure = new Map();
  function reach(id) {
    if (closure.has(id)) return closure.get(id);
    const seen = new Set();
    const pending = [...(direct.get(id) || [])];
    while (pending.length) {
      const next = pending.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      for (const further of direct.get(next) || []) pending.push(further);
    }
    closure.set(id, seen);
    return seen;
  }
  return (a, b) => reach(a).has(b);
}

/**
 * Everything the Mods page needs about load order, in one pass:
 *   effectiveModOrder    ids in the order the server loads them
 *   orderWarnings        [{ code, severity, modId, ... }]:
 *     requireCycle         (high)   require= entries form a loop; the game
 *                                   overflows its stack loading them
 *     requireNotFound      (high)   a require= id (missing) is not among the
 *                                   server's Workshop mods: the mod (and what
 *                                   requires it, via) is skipped; caseMatch
 *                                   names a mod whose id differs only in case
 *     requireUnavailable   (high)   the required mod exists but cannot load
 *                                   itself
 *     requireEntryInvalid  (high)   the require= entry itself is malformed
 *                                   (entry; issue: emptyEntry, blankEntry,
 *                                   whitespace, semicolon); the mod is skipped
 *     requireAutoLoaded    (info)   a required mod missing from Mods= is
 *                                   loaded anyway (dependency: id)
 *     requireReordered     (info)   Mods= lists a mod before something it
 *                                   requires; the game loads the dependency
 *                                   first (dependency: id)
 *     loadAfterViolated    (medium) loadModAfter= is not met by the order
 *                                   (other: id); the server ignores it
 *     loadBeforeViolated   (medium) loadModBefore= is not met (other: id)
 *     declaredIncompatible (high)   both mods of an incompatible= pair load
 *                                   (other: id)
 *     modInfoListIssue     (low)    a loadModAfter=/loadModBefore=/
 *                                   incompatible= entry the game cannot
 *                                   match (field, entry, issue)
 *     modNotFound          (info)   a Mods= id the panel cannot see on disk
 *   orderingConstraints  computeOrderingConstraints() over `mods`
 */
export function analyzeModOrder(modsLine, mods, options = {}) {
  const catalog = toCatalog(mods);
  const { order, notLoaded, warnings } = computeEffectiveModOrder(modsLine, mods);
  const position = new Map(order.map((id, i) => [id, i]));
  const listed = new Set(modsLine || []);
  const listedPosition = new Map();
  (modsLine || []).forEach((id, i) => {
    if (!listedPosition.has(id)) listedPosition.set(id, i);
  });
  const orderWarnings = [...warnings];

  const lowerIds = new Map();
  for (const id of catalog.keys()) {
    const lower = id.toLowerCase();
    if (!lowerIds.has(lower)) lowerIds.set(lower, id);
  }
  for (const entry of notLoaded) {
    if (entry.cause === "requireCycle") continue;
    const blocker = entry.via || entry.modId;
    const via = blocker !== entry.modId ? { via: blocker } : {};
    const missing = typeof entry.missing === "string" ? entry.missing : "";
    const issue = (catalog.get(blocker)?.modInfoIssues || []).find(
      (i) => i.field === "require" && (i.entry === missing || (i.code === "semicolon" && i.entry === missing.trim())),
    );
    if (issue) {
      orderWarnings.push({ code: "requireEntryInvalid", severity: "high", modId: entry.modId, ...via, entry: issue.entry, issue: issue.code });
      continue;
    }
    if (catalog.has(missing.trim())) {
      orderWarnings.push({ code: "requireUnavailable", severity: "high", modId: entry.modId, ...via, missing });
      continue;
    }
    const caseMatch = lowerIds.get(missing.trim().toLowerCase());
    orderWarnings.push({
      code: "requireNotFound",
      severity: "high",
      modId: entry.modId,
      ...via,
      missing,
      ...(caseMatch ? { caseMatch } : {}),
    });
  }

  for (const id of order) {
    const mod = catalog.get(id);
    if (!mod) continue;
    for (const dep of trimmedIds(mod.require)) {
      if (!position.has(dep)) continue;
      if (!listed.has(dep)) {
        orderWarnings.push({ code: "requireAutoLoaded", severity: "info", modId: id, dependency: dep });
      } else if (listed.has(id) && listedPosition.get(dep) > listedPosition.get(id)) {
        orderWarnings.push({ code: "requireReordered", severity: "info", modId: id, dependency: dep });
      }
    }
    for (const other of mod.loadAfter || []) {
      if (position.has(other) && position.get(other) > position.get(id)) {
        orderWarnings.push({ code: "loadAfterViolated", severity: "medium", modId: id, other });
      }
    }
    for (const other of mod.loadBefore || []) {
      if (position.has(other) && position.get(other) < position.get(id)) {
        orderWarnings.push({ code: "loadBeforeViolated", severity: "medium", modId: id, other });
      }
    }
    for (const issue of mod.modInfoIssues || []) {
      if (issue.field === "require") continue;
      orderWarnings.push({ code: "modInfoListIssue", severity: "low", modId: id, field: issue.field, entry: issue.entry, issue: issue.code });
    }
  }

  for (const pair of findIncompatiblePairs(order, mods)) {
    orderWarnings.push({ code: "declaredIncompatible", severity: "high", modId: pair.a, other: pair.b });
  }

  return {
    effectiveModOrder: order,
    orderWarnings,
    orderingConstraints: computeOrderingConstraints(mods, options),
  };
}

/**
 * Pairs of loaded mods where either one lists the other in incompatible=
 * (the main menu treats it as symmetric). [{ a, b, declaredBy }], a before b
 * in `loadedIds`.
 */
export function findIncompatiblePairs(loadedIds, mods) {
  const catalog = toCatalog(mods);
  const loaded = new Set(loadedIds || []);
  const position = new Map((loadedIds || []).map((id, i) => [id, i]));
  const seen = new Set();
  const pairs = [];
  for (const id of loadedIds || []) {
    const mod = catalog.get(id);
    if (!mod) continue;
    for (const other of mod.incompatible || []) {
      if (other === id || !loaded.has(other)) continue;
      const [a, b] = position.get(id) < position.get(other) ? [id, other] : [other, id];
      const key = `${a}\u0000${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b, declaredBy: id });
    }
  }
  return pairs;
}
