// Everything the smart load-order routes (routes/modsSmart.js) know about the
// active server's mod list, read once per request: the ini's Mods=,
// WorkshopItems= and Map=, every mod of the listed Workshop items (with the
// mod.info Build 42 reads, so a B41-only folder does not count as a mod), the
// order the server really loads, what each loaded mod's folders contain, the
// cached Steam knowledge, the stored groups and order rules. The pure cores
// (utils/modClassification.js, modSmartSort.js, modHealth.js) work on it.

import fs from "fs";
import path from "path";
import { getModGroups, getModOrderRules, getTrackedMods } from "../database/init.js";
import { readTextFile, splitIniList, splitModIdTokens } from "../utils/modIni.js";
import { analyzeModOrder, computeOrderingConstraints, normaliseModInfoList, pickModVersionFolder } from "../utils/modLoadOrder.js";
import { profileModFolders } from "../utils/modContentProfile.js";
import { classifyMods } from "../utils/modClassification.js";
import { buildLoadOrderConstraints, planLoadOrder } from "../utils/modSmartSort.js";
import { normalizeGroup } from "../utils/modGroups.js";
import { VANILLA_MAP_FOLDERS } from "../utils/modHealth.js";
import { getBridgeManaged } from "./bridgeDelivery.js";
import {
  findMapFoldersFromWorkshop,
  getModDetailsFromModsFolder,
  getModDetailsFromWorkshop,
  getWorkshopPaths,
} from "./workshopModInfo.js";
import { peekSteamKnowledge } from "./modSteamKnowledge.js";

const MODS_RE = /^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m;
const WORKSHOP_ITEMS_RE = /^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m;
const MAP_RE = /^[ \t]*Map[ \t]*=[ \t]*(.*)$/m;
const WORKSHOP_ID = /^\d{1,15}$/;

const uniq = (list) => [...new Set(list)];

/** Mods= (ids and raw tokens), WorkshopItems= and Map= of an ini text. */
export function readModLists(content) {
  const text = String(content ?? "");
  const tokens = splitModIdTokens(text.match(MODS_RE)?.[1]);
  const mapMatch = text.match(MAP_RE);
  return {
    tokens,
    modsLine: uniq(tokens.map((t) => t.id)),
    workshopItems: uniq(splitIniList(text.match(WORKSHOP_ITEMS_RE)?.[1])),
    maps: mapMatch ? splitIniList(mapMatch[1]) : ["Muldraugh, KY"],
    hasMapLine: Boolean(mapMatch),
  };
}

// Whether Build 42 sees this mod folder at all: it lists only folders with a
// common/mod.info or a <version folder>/mod.info (utils/modLoadOrder.js).
function hasB42ModInfo(modDir) {
  let names;
  try {
    names = fs.readdirSync(modDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return false;
  }
  const versionFolder = pickModVersionFolder(names);
  if (versionFolder && fs.existsSync(path.join(modDir, versionFolder, "mod.info"))) return true;
  const common = names.find((name) => name.toLowerCase() === "common");
  return Boolean(common && fs.existsSync(path.join(modDir, common, "mod.info")));
}

function itemFolder(workshopId, serverPath) {
  if (!serverPath) return null;
  for (const candidate of getWorkshopPaths(workshopId, serverPath)) {
    // codeql[js/path-injection] workshopId is checked against /^\d{1,15}$/ before it gets here.
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Where a dedicated server finds mods, in the order it looks
// (ZomboidFileSystem.getAllModFolders, default "workshop,steam,mods" -- read
// from the 42.21 jar): Workshop items staged under <Zomboid>/Workshop/<item>/
// Contents/mods, then the installed Workshop items (WorkshopItems=), then
// <Zomboid>/mods. ChooseGameInfo.getModDetails keeps the FIRST folder found
// for an id (putIfAbsent), so a Workshop copy of an id beats a local one. The
// order of the installed items among themselves is Steam's, not the panel's
// to know.

function modsOfFolder(folder, source) {
  return getModDetailsFromModsFolder(folder).map((mod) => {
    const dir = path.join(folder, mod.folder);
    return { ...mod, workshopId: null, source, dir, b42: hasB42ModInfo(dir) };
  });
}

// The staged items' and the local mods of a data folder.
function dataFolderMods(zomboidDataPath) {
  if (typeof zomboidDataPath !== "string" || !zomboidDataPath) return { staged: [], local: [], readable: false };
  const staged = [];
  let stageFolders = [];
  try {
    // codeql[js/path-injection] zomboidDataPath is the active server's data folder, held to the data-folder rule (getActiveServerPaths).
    stageFolders = fs.readdirSync(path.join(zomboidDataPath, "Workshop"), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    stageFolders = [];
  }
  for (const entry of stageFolders) {
    staged.push(...modsOfFolder(path.join(zomboidDataPath, "Workshop", entry.name, "Contents", "mods"), "staged"));
  }
  // codeql[js/path-injection] see above.
  const readable = fs.existsSync(zomboidDataPath);
  return { staged, local: modsOfFolder(path.join(zomboidDataPath, "mods"), "local"), readable };
}

/**
 * Reads the active server's mod setup. `content` is the ini text,
 * `serverPath` the install folder (Workshop content), `zomboidDataPath` the
 * data folder the server runs with (its mods/ and Workshop/ hold mods too),
 * `extraModIds` ids to profile and classify besides the ones that load (a
 * client's unsaved order). `catalogOnly` stops after the mods and their links
 * (no folder walks, no classification): enough for an order rule's loop check.
 *
 * Every mod has `source` ("workshop", "local" or "staged"); `providers` maps
 * an id to every Build 42 copy of it, in the order the game looks.
 */
export async function loadModSmartContext({ content, serverPath, zomboidDataPath = null, extraModIds = [], catalogOnly = false }) {
  const lists = readModLists(content);
  const itemMods = new Map();
  const itemsOnDisk = new Set();
  const workshopMods = [];
  for (const workshopId of lists.workshopItems) {
    if (!WORKSHOP_ID.test(workshopId)) continue;
    const base = itemFolder(workshopId, serverPath);
    if (!base) continue;
    itemsOnDisk.add(workshopId);
    const searchBase = fs.existsSync(path.join(base, "mods")) ? path.join(base, "mods") : base;
    const mods = getModDetailsFromWorkshop(workshopId, serverPath).map((mod) => {
      const dir = path.join(searchBase, mod.folder);
      return { ...mod, workshopId, source: "workshop", dir, b42: hasB42ModInfo(dir) };
    });
    itemMods.set(workshopId, mods);
    workshopMods.push(...mods);
  }
  const data = dataFolderMods(zomboidDataPath);
  const all = [...data.staged, ...workshopMods, ...data.local];

  // One entry per id: the first Build 42 copy in the game's order; ids no
  // folder ships for B42 are left out of what loads and remembered as
  // B41-only.
  const catalogMap = new Map();
  const providers = new Map();
  for (const mod of all) {
    if (!mod.b42) continue;
    if (!catalogMap.has(mod.id)) catalogMap.set(mod.id, mod);
    if (!providers.has(mod.id)) providers.set(mod.id, []);
    providers.get(mod.id).push({ source: mod.source, workshopId: mod.workshopId });
  }
  const legacyMods = new Map();
  for (const mod of all) {
    if (!mod.b42 && !catalogMap.has(mod.id) && !legacyMods.has(mod.id)) {
      legacyMods.set(mod.id, { workshopId: mod.workshopId, source: mod.source, name: mod.name });
    }
  }
  const catalog = [...catalogMap.values()];
  const localModsReadable = data.readable;
  if (catalogOnly) {
    return { ...lists, serverPath, catalog, catalogMap, legacyMods, itemMods, itemsOnDisk, providers, localModsReadable };
  }
  const analysis = analyzeModOrder(lists.modsLine, catalog);
  const enabled = uniq([
    ...analysis.effectiveModOrder.filter((id) => catalogMap.has(id)),
    ...extraModIds.filter((id) => typeof id === "string" && catalogMap.has(id)),
  ]);

  const profiles = await profileModFolders(enabled.map((id) => ({ key: id, dir: catalogMap.get(id).dir })));
  for (const mod of catalog) mod.profile = profiles.get(mod.id) ?? null;

  const steam = peekSteamKnowledge(lists.workshopItems);
  const steamTags = new Map();
  const steamRequires = new Map();
  const steamTitles = new Map();
  const modIdOrder = new Map();
  for (const [workshopId, entry] of steam.items) {
    steamTags.set(workshopId, entry.tags || []);
    if (Array.isArray(entry.requires)) steamRequires.set(workshopId, entry.requires);
    if (entry.title) steamTitles.set(workshopId, entry.title);
    modIdOrder.set(workshopId, entry.modIdOrder || []);
  }

  const enabledSet = new Set(enabled);
  const namePatches = computeOrderingConstraints(catalog.filter((m) => enabledSet.has(m.id))).filter((e) => e.reason === "patch");
  const classification = classifyMods({ mods: catalog, enabled, steamTags, namePatches });

  return {
    ...lists,
    serverPath,
    catalog,
    catalogMap,
    legacyMods,
    itemMods,
    itemsOnDisk,
    providers,
    localModsReadable,
    analysis,
    enabled,
    classification,
    steam,
    steamTags,
    steamRequires,
    steamTitles,
    modIdOrder,
    groups: (await getModGroups()).map(normalizeGroup),
    rules: await getModOrderRules(),
    bridge: await getBridgeManaged(),
  };
}

/**
 * The hard order constraints (require=, also through a required mod Mods=
 * does not list, and order rules) between the mods of `order`, exactly as the
 * load-order planner builds them: what the group enforcement of routes/mods.js
 * passes to the keep-together rule it shares with the planner
 * (modGroups.js keepTogetherForcedApart). [] when the mod list cannot be read
 * (the enforcement then keeps every group together, as before).
 */
export async function hardOrderEdges(order, { content, serverPath, zomboidDataPath = null }) {
  try {
    const ctx = await loadModSmartContext({ content, serverPath, zomboidDataPath, catalogOnly: true });
    const built = buildLoadOrderConstraints({ order, mods: ctx.catalog, rules: await getModOrderRules() });
    return built.constraints
      .filter((c) => c.reason === "require" || c.reason === "rule")
      .map(({ before, after, reason }) => ({ before, after, reason }));
  } catch {
    return [];
  }
}

/** The require= links between the known mods, as order-rule cycle edges. */
export function requireEdgesOf(ctx) {
  const edges = [];
  for (const mod of ctx.catalog) {
    for (const dep of normaliseModInfoList(mod.require).ids) edges.push({ before: dep, after: mod.id });
  }
  return edges;
}

function steamRequireIds(ctx) {
  const out = new Map();
  for (const [workshopId, requires] of ctx.steamRequires) out.set(workshopId, requires.map((r) => r.workshopId));
  return out;
}

/**
 * The constraints and the plan for `order` (default: the saved Mods=).
 * Returns { built, plan }.
 */
export function planFor(ctx, { order = ctx.modsLine, mode = "minimal", useGroups = true, conflictPairs = [] } = {}) {
  const groups = useGroups ? ctx.groups : [];
  const built = buildLoadOrderConstraints({
    order,
    mods: ctx.catalog,
    classification: ctx.classification,
    rules: ctx.rules,
    groups,
    steamRequires: steamRequireIds(ctx),
    conflictPairs,
  });
  const plan = planLoadOrder({
    order,
    constraints: built.constraints,
    missing: built.missing,
    implicit: built.implicit,
    groups,
    useGroups,
    mode,
    classification: ctx.classification,
  });
  return { built, plan };
}

/** Whether applying `order` would change the order the server loads mods in. */
export function changesLoading(ctx, order) {
  const after = analyzeModOrder(order, ctx.catalog).effectiveModOrder;
  const before = ctx.analysis.effectiveModOrder;
  return after.length !== before.length || after.some((id, i) => id !== before[i]);
}

/**
 * The disk reads only the health check needs. `locate(modIds)` (routes/mods.js
 * locateModsOnDisk) finds the downloaded item that ships a missing id.
 * Returns { located, extraItemMods, itemMapFolders, updates }.
 */
export async function loadHealthExtras(ctx, { locate }) {
  const warnings = ctx.analysis.orderWarnings || [];
  const missingIds = uniq([
    ...warnings.filter((w) => w.code === "requireNotFound").map((w) => String(w.missing ?? "").trim()),
    ...warnings.filter((w) => w.code === "modNotFound").map((w) => w.modId),
  ]).filter((id) => id && !ctx.legacyMods.has(id));
  const located = new Map();
  if (missingIds.length > 0 && typeof locate === "function") {
    for (const [id, workshopId] of locate(missingIds, ctx.workshopItems, ctx.serverPath)) {
      if (!ctx.workshopItems.includes(workshopId)) located.set(id, workshopId);
    }
  }

  const listed = new Set(ctx.workshopItems);
  const extraItemMods = new Map();
  for (const requires of ctx.steamRequires.values()) {
    for (const { workshopId } of requires) {
      if (listed.has(workshopId) || extraItemMods.has(workshopId) || !WORKSHOP_ID.test(workshopId)) continue;
      if (!itemFolder(workshopId, ctx.serverPath)) continue;
      extraItemMods.set(
        workshopId,
        getModDetailsFromWorkshop(workshopId, ctx.serverPath).map((m) => ({ id: m.id, name: m.name })),
      );
    }
  }

  // Item-level map folders: for Map= entries no loaded mod's profile ships,
  // and for items none of whose mods load.
  const vanilla = new Set(VANILLA_MAP_FOLDERS.map((m) => m.toLowerCase()));
  const shipped = new Set();
  for (const id of ctx.enabled) for (const folder of ctx.catalogMap.get(id)?.profile?.mapFolders || []) shipped.add(folder.toLowerCase());
  const unexplained = ctx.maps.some((m) => !vanilla.has(m.toLowerCase()) && !shipped.has(m.toLowerCase()));
  const loadedItems = new Set();
  for (const id of [...ctx.enabled, ...ctx.modsLine]) {
    const ws = ctx.catalogMap.get(id)?.workshopId || ctx.legacyMods.get(id)?.workshopId;
    if (ws) loadedItems.add(ws);
  }
  const itemMapFolders = new Map();
  for (const workshopId of ctx.itemsOnDisk) {
    if (!unexplained && loadedItems.has(workshopId)) continue;
    itemMapFolders.set(workshopId, findMapFoldersFromWorkshop(workshopId, ctx.serverPath));
  }

  let updates = [];
  try {
    updates = ((await getTrackedMods()) || [])
      .filter((m) => m?.update_available === 1 || m?.update_available === true)
      .map((m) => ({ workshopId: String(m.workshop_id), title: typeof m.name === "string" ? m.name : null }));
  } catch {
    updates = [];
  }
  return { located, extraItemMods, itemMapFolders, updates };
}

/**
 * GET /mods/insights: per loaded mod what the panel makes of it, the Steam
 * "Required items" of the listed Workshop items, and every constraint on the
 * saved order.
 */
export function buildModInsights(ctx, built, steamStatus) {
  const loaded = new Set(ctx.enabled);
  const listedMods = new Set(ctx.modsLine);
  const mods = Object.create(null);
  for (const id of ctx.enabled) {
    const mod = ctx.catalogMap.get(id);
    const info = ctx.classification.get(id);
    if (!mod || !info) continue;
    mods[id] = {
      workshopId: mod.workshopId,
      source: mod.source,
      name: mod.name || id,
      enabled: listedMods.has(id),
      kind: info.kind,
      kindConfidence: info.confidence,
      kindReasons: info.reasons,
      tier: info.tier,
      patchOf: info.patchOf,
      dependents: info.dependents,
      requires: info.requires,
      requiredBy: info.requiredBy,
      steamTags: ctx.steamTags.get(mod.workshopId) || [],
    };
  }
  const listed = new Set(ctx.workshopItems);
  const itemHasLoadedMod = new Set();
  for (const id of loaded) {
    const ws = ctx.catalogMap.get(id)?.workshopId;
    if (ws) itemHasLoadedMod.add(ws);
  }
  const workshopRequirements = [];
  for (const workshopId of ctx.workshopItems) {
    const requires = ctx.steamRequires.get(workshopId);
    if (!requires || requires.length === 0) continue;
    workshopRequirements.push({
      workshopId,
      title: ctx.steamTitles.get(workshopId) || null,
      requires: requires.map((r) => ({
        workshopId: r.workshopId,
        title: r.title || ctx.steamTitles.get(r.workshopId) || null,
        installed: listed.has(r.workshopId),
        enabled: itemHasLoadedMod.has(r.workshopId),
      })),
    });
  }
  const constraints = built.constraints.map(({ groupIndex: _groupIndex, ...c }) => c);
  return { generatedAt: new Date().toISOString(), steamStatus, mods, workshopRequirements, constraints };
}

export { readTextFile };
