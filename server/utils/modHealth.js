// The mod list health check: everything wrong with the active server's mod
// setup, each issue with the one-click fixes the panel can apply. Pure: the
// route gathers what is on disk (services/modSmartContext.js) and applies a
// fix through the ini lock and backup (routes/modsSmart.js).
//
// Kinds (game facts: utils/modLoadOrder.js header):
//   critical  requireLoop             require= entries form a loop: the
//                                     server's loader overflows its stack
//             modInfoBroken           a require= entry the game cannot match
//                                     ("require=" empty, "A,,B", "A, B",
//                                     "A;B") keeps the mod from loading
//             requiredNotInstalled    a required mod is in no installed
//                                     Workshop item: what needs it is skipped
//   warning   requiredWorkshopItemMissing  a Workshop "Required item" of an
//                                     item in use is not in WorkshopItems=
//             notInstalled            a Mods= id no installed item ships
//             b41Only                 a Mods= id whose folder has no Build 42
//                                     mod.info (never loads on B42)
//             incompatibleEnabled     both mods of an incompatible= pair load
//             duplicateModId          two folders the server reads ship the
//                                     same id: a staged item's copy beats a
//                                     Workshop item's, which beats a local
//                                     one (<Zomboid>/mods); between two
//                                     Workshop items (or two local folders)
//                                     which one loads is not defined
//             mapNotInMapLine         a loaded mod ships a map Map= lacks
//             mapFolderWithoutMod     Map= names a folder no loaded mod ships
//             orderProblems           the planner would reorder Mods= for
//                                     hard or strong reasons (info when the
//                                     order the game loads stays the same)
//   info      requiredLoadedImplicitly  a required mod Mods= does not list
//                                     (the game loads it first anyway)
//             unusedWorkshopItem      an item none of whose mods load and
//                                     whose maps are not in Map=
//             updatesAvailable        the update checker knows of updates
//
// Every issue has a stable `id` (its kind and sorted subjects), so a fix
// request names an issue the server recomputes, and a fix is one of the
// issue's own fixes: the client can never send an arbitrary ini edit.

import crypto from "crypto";
import { findIncompatiblePairs, normaliseModInfoList } from "./modLoadOrder.js";

export const HEALTH_SEVERITIES = Object.freeze(["critical", "warning", "info"]);

export const HEALTH_KINDS = Object.freeze([
  "requireLoop",
  "modInfoBroken",
  "requiredNotInstalled",
  "requiredWorkshopItemMissing",
  "notInstalled",
  "b41Only",
  "incompatibleEnabled",
  "duplicateModId",
  "mapNotInMapLine",
  "mapFolderWithoutMod",
  "orderProblems",
  "requiredLoadedImplicitly",
  "unusedWorkshopItem",
  "updatesAvailable",
]);

export const HEALTH_FIX_ACTIONS = Object.freeze([
  "removeMods",
  "addMods",
  "addWorkshopItems",
  "removeWorkshopItems",
  "addMapFolders",
  "removeMapFolders",
  "applyPlan",
]);

// The maps a Build 42 install ships (media/maps of the game).
export const VANILLA_MAP_FOLDERS = Object.freeze([
  "Muldraugh, KY",
  "Brandenburg, KY",
  "Echo Creek, KY",
  "Ekron, KY",
  "Fallas Lake, KY",
  "Irvington, KY",
  "March Ridge, KY",
  "Riverside, KY",
  "Rosewood, KY",
  "Valley Station, KY",
  "West Point, KY",
  "challengemaps",
]);

export const HEALTH_LIMITS = Object.freeze({
  maxIssues: 2000,
  maxListed: 50,
  maxSampleMoves: 10,
  maxSteamCandidates: 10,
});

const HARD_OR_STRONG = new Set([
  "require",
  "rule",
  "groupOrder",
  "keepTogether",
  "groupPlacement",
  "loadAfter",
  "loadBefore",
  "steamRequired",
  "patch",
  "conflictWinner",
]);

const ISSUE_ID = /^[A-Za-z][A-Za-z0-9]{0,40}-[0-9a-f]{16}$/;

/** True for a string shaped like a health issue id. */
export function isHealthIssueId(value) {
  return typeof value === "string" && ISSUE_ID.test(value);
}

/** The stable id of an issue: its kind and a hash of its sorted subjects. */
export function healthIssueId(kind, subjects) {
  const sorted = [...new Set(subjects.map(String))].sort();
  const hash = crypto.createHash("sha256").update(`${kind}\n${sorted.join("\n")}`).digest("hex").slice(0, 16);
  return `${kind}-${hash}`;
}

/** A mod id the panel may write into Mods= (Workshop content can hold anything). */
export function isWritableModId(id) {
  if (typeof id !== "string") return false;
  if (!id.trim() || id.length > 200 || id !== id.trim()) return false;
  return !/[\u0000-\u001f\u007f-\u009f;=\\]/.test(id);
}

export function isWritableWorkshopId(id) {
  return typeof id === "string" && /^\d{1,15}$/.test(id);
}

export function isWritableMapFolder(name) {
  return typeof name === "string" && name.trim() !== "" && !/[\u0000-\u001f\u007f;=]/.test(name);
}

/** JSON with object keys sorted, for comparing fix params. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// The order the game looks for mods in (services/modSmartContext.js): the
// first folder with an id is the one it loads.
const SOURCE_RANK = { staged: 0, workshop: 1, local: 2 };

const lower = (s) => String(s).toLowerCase();
const uniq = (list) => [...new Set(list)];

/**
 * @param {object} input  see services/modSmartContext.js loadModSmartContext()
 *   and loadHealthExtras(): modsLine, workshopItems, maps, catalog,
 *   legacyMods, itemMods, itemsOnDisk, analysis, located, extraItemMods,
 *   steamRequires, steamTitles, itemMapFolders, updates, bridge, plan,
 *   planChangesLoading, now
 * @returns {{ checkedAt, counts, issues }}
 */
export function computeModHealth(input) {
  const {
    modsLine = [],
    workshopItems = [],
    maps = [],
    catalog = [],
    legacyMods = new Map(),
    itemMods = new Map(),
    providers = null,
    localModsReadable = true,
    itemsOnDisk = new Set(),
    analysis = { effectiveModOrder: [], orderWarnings: [] },
    located = new Map(),
    extraItemMods = new Map(),
    steamRequires = new Map(),
    steamTitles = new Map(),
    itemMapFolders = new Map(),
    updates = [],
    bridge = null,
    plan = null,
    planChangesLoading = false,
    now = Date.now(),
  } = input || {};

  const byId = new Map();
  for (const mod of catalog) if (mod?.id && !byId.has(mod.id)) byId.set(mod.id, mod);
  const listed = new Set(modsLine);
  const listedIndex = new Map(modsLine.map((id, i) => [id, i]));
  const effective = analysis.effectiveModOrder || [];
  const loaded = new Set(effective);
  const listedItems = new Set(workshopItems);
  const bridgeModId = bridge?.modId || null;
  const bridgeItem = bridge?.workshopId ? String(bridge.workshopId) : null;
  const itemOf = (id) => byId.get(id)?.workshopId || legacyMods.get(id)?.workshopId || null;
  const itemsOf = (ids) => uniq(ids.map(itemOf).filter(Boolean));
  const mapSet = new Set(maps.map(lower));
  const vanilla = new Set(VANILLA_MAP_FOLDERS.map(lower));
  const firstListed = (ids) => ids.filter((id) => listed.has(id)).sort((a, b) => listedIndex.get(a) - listedIndex.get(b))[0];

  const issues = [];
  const add = (kind, severity, { modIds = [], workshopIds = [], params = {}, fixes = [], subjects = null }) => {
    if (issues.length >= HEALTH_LIMITS.maxIssues) return;
    const mods = uniq(modIds).slice(0, HEALTH_LIMITS.maxListed);
    const items = uniq(workshopIds.map(String)).slice(0, HEALTH_LIMITS.maxListed);
    issues.push({
      id: healthIssueId(kind, subjects || [...mods.map((m) => `m:${m}`), ...items.map((w) => `w:${w}`)]),
      kind,
      severity,
      modIds: mods,
      workshopIds: items,
      params,
      fixes,
    });
  };
  const removeFix = (ids) => {
    const safe = ids.filter((id) => listed.has(id) && id !== bridgeModId && isWritableModId(id));
    return safe.length ? { action: "removeMods", params: { modIds: safe }, label: `Remove ${safe.join(", ")} from Mods=` } : null;
  };
  const addItemsFix = (wsIds, modIds = [], before) => {
    const items = wsIds.filter(isWritableWorkshopId);
    if (items.length === 0) return null;
    const mods = modIds.filter(isWritableModId);
    const params = { workshopIds: items, ...(mods.length ? { modIds: mods } : {}), ...(mods.length && before ? { before } : {}) };
    return { action: "addWorkshopItems", params, label: `Add Workshop item${items.length > 1 ? "s" : ""} ${items.join(", ")}` };
  };

  // Require closures (what loading `id` pulls in), for "where does the game
  // load this required mod".
  const closureCache = new Map();
  const requireClosure = (id) => {
    if (closureCache.has(id)) return closureCache.get(id);
    const seen = new Set();
    const stack = normaliseModInfoList(byId.get(id)?.require).ids;
    while (stack.length && seen.size < 5000) {
      const next = stack.pop();
      if (seen.has(next) || next === id) continue;
      seen.add(next);
      stack.push(...normaliseModInfoList(byId.get(next)?.require).ids);
    }
    closureCache.set(id, seen);
    return seen;
  };

  const warnings = analysis.orderWarnings || [];

  // ── requireLoop ──
  for (const w of warnings.filter((x) => x.code === "requireCycle")) {
    const mods = uniq(Array.isArray(w.cycle) ? w.cycle : [w.modId]);
    const candidates = uniq([...mods.filter((id) => listed.has(id)), w.modId]);
    add("requireLoop", "critical", {
      modIds: mods,
      workshopIds: itemsOf(mods),
      params: { cycle: mods },
      fixes: candidates.map((id) => removeFix([id])).filter(Boolean),
    });
  }

  // ── modInfoBroken ──
  const broken = new Map();
  for (const w of warnings.filter((x) => x.code === "requireEntryInvalid")) {
    const blocker = w.via || w.modId;
    const key = `${blocker}\u0000${w.entry}`;
    if (!broken.has(key)) broken.set(key, { blocker, entry: w.entry, issue: w.issue, affected: [] });
    broken.get(key).affected.push(w.modId);
  }
  for (const { blocker, entry, issue, affected } of broken.values()) {
    add("modInfoBroken", "critical", {
      modIds: [blocker],
      workshopIds: itemsOf([blocker]),
      params: { modId: blocker, field: "require", entry, issue, affected: uniq(affected).slice(0, HEALTH_LIMITS.maxListed) },
      subjects: [`m:${blocker}`, `e:${entry}`],
    });
  }

  // ── requiredNotInstalled (and a required mod that is B41-only) ──
  const missing = new Map();
  for (const w of warnings.filter((x) => x.code === "requireNotFound")) {
    const id = String(w.missing ?? "").trim();
    if (!id) continue;
    if (!missing.has(id)) missing.set(id, { requiredBy: [], affected: [], caseMatch: w.caseMatch });
    const entry = missing.get(id);
    entry.requiredBy.push(w.via || w.modId);
    entry.affected.push(w.modId);
  }
  const itemsAddedForMissing = new Set();
  for (const [id, { requiredBy, affected, caseMatch }] of missing) {
    const requirers = uniq(requiredBy);
    const legacy = legacyMods.get(id);
    const fixes = [];
    if (!caseMatch && !legacy) {
      const provider = located.get(id);
      if (provider) {
        const fix = addItemsFix([provider], [id], firstListed(affected));
        if (fix) fixes.push(fix);
        itemsAddedForMissing.add(provider);
      } else {
        const candidates = uniq(
          itemsOf(requirers).flatMap((ws) => (steamRequires.get(ws) || []).map((r) => r.workshopId)),
        ).filter((ws) => !listedItems.has(ws) && ws !== bridgeItem);
        if (candidates.length > 0 && candidates.length <= HEALTH_LIMITS.maxSteamCandidates) {
          const fix = addItemsFix(candidates);
          if (fix) fixes.push(fix);
          candidates.forEach((ws) => itemsAddedForMissing.add(ws));
        }
      }
    }
    add("requiredNotInstalled", "critical", {
      modIds: requirers,
      workshopIds: itemsOf(requirers),
      params: {
        missing: id,
        requiredBy: requirers,
        affected: uniq(affected).slice(0, HEALTH_LIMITS.maxListed),
        ...(caseMatch ? { caseMatch } : {}),
        ...(legacy ? { b41Only: true, workshopId: legacy.workshopId, source: legacy.source || "workshop" } : {}),
        ...(localModsReadable ? {} : { localModsUnknown: true }),
      },
      fixes,
      subjects: [`missing:${id}`],
    });
  }

  // ── requiredWorkshopItemMissing ──
  const inUse = new Set();
  for (const id of [...effective, ...modsLine]) {
    const ws = itemOf(id);
    if (ws) inUse.add(ws);
  }
  const requiredMissing = new Map();
  for (const ws of workshopItems) {
    if (!inUse.has(ws)) continue;
    for (const req of steamRequires.get(ws) || []) {
      const target = req.workshopId;
      if (listedItems.has(target) || target === bridgeItem || itemsAddedForMissing.has(target)) continue;
      if (!requiredMissing.has(target)) requiredMissing.set(target, { title: req.title || steamTitles.get(target) || null, requiredBy: [] });
      requiredMissing.get(target).requiredBy.push(ws);
    }
  }
  for (const [target, { title, requiredBy }] of requiredMissing) {
    const theirMods = extraItemMods.get(target) || [];
    const theirIds = new Set(theirMods.map((m) => m.id));
    const needed = [];
    const dependents = [];
    for (const id of effective) {
      if (!requiredBy.includes(itemOf(id))) continue;
      dependents.push(id);
      for (const dep of normaliseModInfoList(byId.get(id)?.require).ids) if (theirIds.has(dep)) needed.push(dep);
    }
    const toEnable = uniq(needed.length ? needed : theirMods.length === 1 ? [theirMods[0].id] : []).filter((id) => !listed.has(id));
    const fix = addItemsFix([target], toEnable, firstListed(dependents));
    add("requiredWorkshopItemMissing", "warning", {
      modIds: toEnable,
      workshopIds: [target, ...requiredBy],
      params: { workshopId: target, title, requiredBy: uniq(requiredBy), downloaded: extraItemMods.has(target) },
      fixes: fix ? [fix] : [],
      subjects: [`w:${target}`],
    });
  }

  // ── requiredLoadedImplicitly ──
  const implicit = new Map();
  for (const w of warnings.filter((x) => x.code === "requireAutoLoaded")) {
    if (!implicit.has(w.dependency)) implicit.set(w.dependency, []);
    implicit.get(w.dependency).push(w.modId);
  }
  for (const [dep, requiredBy] of implicit) {
    const root = modsLine.find((id) => requireClosure(id).has(dep));
    const fixes = isWritableModId(dep)
      ? [{ action: "addMods", params: { modIds: [dep], ...(root ? { before: root } : {}) }, label: `Add ${dep} to Mods=` }]
      : [];
    add("requiredLoadedImplicitly", "info", {
      modIds: [dep],
      workshopIds: itemsOf([dep]),
      params: { modId: dep, requiredBy: uniq(requiredBy) },
      fixes,
    });
  }

  // ── notInstalled / b41Only ──
  const notDownloaded = workshopItems.filter((ws) => !itemsOnDisk.has(ws)).length;
  for (const w of warnings.filter((x) => x.code === "modNotFound")) {
    const id = w.modId;
    if (id === bridgeModId) continue;
    const legacy = legacyMods.get(id);
    if (legacy) {
      const fix = removeFix([id]);
      add("b41Only", "warning", {
        modIds: [id],
        workshopIds: legacy.workshopId ? [legacy.workshopId] : [],
        params: { modId: id, workshopId: legacy.workshopId || null, source: legacy.source || "workshop" },
        fixes: fix ? [fix] : [],
      });
      continue;
    }
    const fixes = [];
    const provider = located.get(id);
    if (provider) {
      const fix = addItemsFix([provider]);
      if (fix) fixes.push(fix);
    }
    // Without the data folder's mods/ the panel cannot rule out a local
    // mod the game loads: no removal offered then, and only an info.
    const remove = localModsReadable ? removeFix([id]) : null;
    if (remove) fixes.push(remove);
    add("notInstalled", localModsReadable ? "warning" : "info", {
      modIds: [id],
      workshopIds: provider ? [provider] : [],
      params: {
        modId: id,
        ...(provider ? { foundIn: provider } : {}),
        notDownloaded,
        ...(localModsReadable ? {} : { localModsUnknown: true }),
      },
      fixes,
    });
  }

  // ── incompatibleEnabled ──
  for (const pair of findIncompatiblePairs(effective, catalog)) {
    add("incompatibleEnabled", "warning", {
      modIds: [pair.a, pair.b],
      workshopIds: itemsOf([pair.a, pair.b]),
      params: { modId: pair.a, other: pair.b, declaredBy: pair.declaredBy },
      fixes: [removeFix([pair.a]), removeFix([pair.b])].filter(Boolean),
    });
  }

  // ── duplicateModId ──
  // Every Build 42 copy of each loaded id, in the order the game looks.
  let copies = providers;
  if (!(copies instanceof Map)) {
    copies = new Map();
    for (const [ws, mods] of itemMods) {
      for (const mod of mods) {
        if (mod.b42 === false) continue;
        if (!copies.has(mod.id)) copies.set(mod.id, []);
        copies.get(mod.id).push({ source: "workshop", workshopId: ws });
      }
    }
  }
  for (const [id, list] of copies) {
    if (!loaded.has(id)) continue;
    const distinct = list;
    if (distinct.length < 2) continue;
    const best = Math.min(...distinct.map((c) => SOURCE_RANK[c.source] ?? 9));
    const first = distinct.filter((c) => (SOURCE_RANK[c.source] ?? 9) === best);
    const items = uniq(distinct.filter((c) => c.workshopId).map((c) => c.workshopId));
    add("duplicateModId", "warning", {
      modIds: [id],
      workshopIds: items,
      params: {
        modId: id,
        workshopIds: items,
        copies: distinct.map((c) => ({ source: c.source, workshopId: c.workshopId || null })),
        // The copy the game loads, or null when that is not defined (two
        // Workshop items, or two local folders).
        loads: first.length === 1 ? { source: first[0].source, workshopId: first[0].workshopId || null } : null,
      },
      subjects: [`m:${id}`, ...distinct.map((c) => `${c.source}:${c.workshopId || ""}`)],
    });
  }

  // ── Maps ──
  const shippedByLoaded = new Set();
  for (const id of effective) {
    const mod = byId.get(id);
    const folders = (mod?.profile?.mapFolders || []).filter(isWritableMapFolder);
    for (const folder of folders) shippedByLoaded.add(lower(folder));
    const notListed = uniq(folders.filter((f) => !mapSet.has(lower(f)) && !vanilla.has(lower(f))));
    if (notListed.length === 0) continue;
    add("mapNotInMapLine", "warning", {
      modIds: [id],
      workshopIds: itemsOf([id]),
      params: { modId: id, folders: notListed },
      fixes: [{ action: "addMapFolders", params: { folders: notListed }, label: `Add ${notListed.join(", ")} to Map=` }],
    });
  }
  for (const ws of inUse) for (const folder of itemMapFolders.get(ws) || []) shippedByLoaded.add(lower(folder));
  for (const folder of uniq(maps)) {
    const key = lower(folder);
    if (vanilla.has(key) || shippedByLoaded.has(key)) continue;
    const shippedBy = [];
    for (const [ws, folders] of itemMapFolders) {
      if (folders.some((f) => lower(f) === key)) shippedBy.push({ workshopId: ws, modIds: (itemMods.get(ws) || []).map((m) => m.id) });
    }
    const fixes = [];
    if (isWritableMapFolder(folder)) fixes.push({ action: "removeMapFolders", params: { folders: [folder] }, label: `Remove ${folder} from Map=` });
    if (shippedBy.length === 1 && shippedBy[0].modIds.length === 1 && isWritableModId(shippedBy[0].modIds[0])) {
      const modId = shippedBy[0].modIds[0];
      fixes.push({ action: "addMods", params: { modIds: [modId] }, label: `Add ${modId} to Mods=` });
    }
    add("mapFolderWithoutMod", "warning", {
      modIds: [],
      workshopIds: shippedBy.map((s) => s.workshopId),
      params: { folder, shippedBy: shippedBy.slice(0, HEALTH_LIMITS.maxListed) },
      fixes,
      subjects: [`map:${folder}`],
    });
  }

  // ── unusedWorkshopItem ──
  const requiredByInUse = new Set();
  for (const ws of inUse) for (const req of steamRequires.get(ws) || []) requiredByInUse.add(req.workshopId);
  for (const ws of workshopItems) {
    if (!itemsOnDisk.has(ws) || inUse.has(ws) || ws === bridgeItem || requiredByInUse.has(ws)) continue;
    const mods = itemMods.get(ws) || [];
    if (mods.length === 0) continue;
    if ((itemMapFolders.get(ws) || []).some((f) => mapSet.has(lower(f)))) continue;
    add("unusedWorkshopItem", "info", {
      modIds: [],
      workshopIds: [ws],
      params: { workshopId: ws, title: steamTitles.get(ws) || null, modIds: mods.map((m) => m.id).slice(0, HEALTH_LIMITS.maxListed) },
      fixes: isWritableWorkshopId(ws)
        ? [{ action: "removeWorkshopItems", params: { workshopIds: [ws] }, label: `Remove Workshop item ${ws}` }]
        : [],
    });
  }

  // ── orderProblems ──
  if (plan?.changed) {
    const real = (plan.moves || []).filter((m) => m.reasons.some((r) => HARD_OR_STRONG.has(r.code)));
    if (real.length > 0) {
      add("orderProblems", planChangesLoading ? "warning" : "info", {
        modIds: real.map((m) => m.modId),
        params: {
          moves: real.length,
          changesLoading: planChangesLoading === true,
          sample: real.slice(0, HEALTH_LIMITS.maxSampleMoves).map((m) => ({
            modId: m.modId,
            from: m.from,
            to: m.to,
            reasons: uniq(m.reasons.map((r) => r.code)),
          })),
        },
        fixes: [{ action: "applyPlan", params: {}, label: "Apply the suggested load order" }],
        subjects: real.map((m) => `m:${m.modId}`),
      });
    }
  }

  // ── updatesAvailable ──
  const updateItems = uniq((updates || []).map((u) => String(u.workshopId)).filter((ws) => listedItems.has(ws)));
  if (updateItems.length > 0) {
    add("updatesAvailable", "info", {
      workshopIds: updateItems,
      params: {
        count: updateItems.length,
        items: updates
          .filter((u) => updateItems.includes(String(u.workshopId)))
          .slice(0, HEALTH_LIMITS.maxListed)
          .map((u) => ({ workshopId: String(u.workshopId), title: u.title || null })),
      },
      subjects: ["updates"],
    });
  }

  const severityRank = { critical: 0, warning: 1, info: 2 };
  const kindRank = new Map(HEALTH_KINDS.map((k, i) => [k, i]));
  issues.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      kindRank.get(a.kind) - kindRank.get(b.kind) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return { checkedAt: new Date(now).toISOString(), counts, issues };
}

/**
 * The fix a request names: the issue by id, then the fix by action, and by
 * params when the issue offers that action more than once. Returns
 * { issue, fix } or { error: "gone" | "fix" }.
 */
export function findHealthFix(health, issueId, action, params) {
  const issue = (health?.issues || []).find((i) => i.id === issueId);
  if (!issue) return { error: "gone" };
  const offered = issue.fixes.filter((f) => f.action === action);
  if (offered.length === 0) return { error: "fix" };
  if (params !== undefined && params !== null) {
    const wanted = canonicalJson(params);
    const fix = offered.find((f) => canonicalJson(f.params) === wanted);
    return fix ? { issue, fix } : { error: "fix" };
  }
  return offered.length === 1 ? { issue, fix: offered[0] } : { error: "fix" };
}
