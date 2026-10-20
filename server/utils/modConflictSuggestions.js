// Which mod should win a conflicting pair, when the panel has a reason to
// think so. Added to every pair of a conflict scan as
//   suggestion: { winner, confidence, reason, alreadyWinning, params? }
// and left out when there is no signal (never a guess on update time).
//
// Reasons, strongest first (the first that applies decides):
//   rule              an order rule already decides the pair (high)
//   requiresOther     one mod require=s the other, directly or through other
//                     mods: the dependent is meant to override (high)
//   declaresLoadAfter one mod declares loadModAfter= the other (or the other
//                     loadModBefore= it) (high)
//   patchOfOther      the classifier recognised one as a patch of the other
//                     (its confidence)
//   translation       a translation mod against what it translates, over
//                     translation files only (medium)
//   smallOverride     a small mod whose conflicting files are a large share of
//                     its own, against a big mod: a deliberate override
//                     (medium)
//   sameWorkshopItem  both from one Workshop item whose description lists
//                     them ("Mod ID:" lines): the author's order (low)
// Resolving a pair in the UI stores an order rule (before: loser, after:
// winner); the next scan answers it with reason "rule" and the load-order
// planner keeps it.

import { normaliseModInfoList } from "./modLoadOrder.js";
import { usableOrderRules } from "./modOrderRules.js";

export const CONFLICT_SUGGESTION_LIMITS = Object.freeze({
  // smallOverride: the small mod has at most this many files, at least this
  // share of them conflict, and the other mod is at least this many times
  // bigger.
  smallMaxFiles: 50,
  smallConflictShare: 0.5,
  bigFactor: 5,
  maxRequireWalk: 2000,
});

function listOf(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * The context the suggestions read (the scan's own data):
 *   mods            [{ id, workshopId?, require?, loadAfter?, loadBefore? }]
 *   classification  classifyMods() result (kind, patchOf, confidence)
 *   rules           stored order rules
 *   fileCounts      Map<modId, number>: each mod's indexed files
 *   modIdOrder      Map<workshopId, string[]>: "Mod ID:" order on Steam
 *   effectiveOrder  the order the server loads the mods in
 */
export function createSuggestionContext({
  mods = [],
  classification = new Map(),
  rules = [],
  fileCounts = new Map(),
  modIdOrder = new Map(),
  effectiveOrder = [],
} = {}) {
  const catalog = new Map();
  for (const mod of Array.isArray(mods) ? mods : []) {
    if (mod && typeof mod.id === "string" && mod.id && !catalog.has(mod.id)) catalog.set(mod.id, mod);
  }
  const requireClosure = new Map();
  const requiresTransitively = (a, b) => {
    if (!requireClosure.has(a)) {
      const seen = new Set();
      const stack = normaliseModInfoList(catalog.get(a)?.require).ids;
      while (stack.length > 0 && seen.size < CONFLICT_SUGGESTION_LIMITS.maxRequireWalk) {
        const next = stack.pop();
        if (seen.has(next) || next === a) continue;
        seen.add(next);
        stack.push(...normaliseModInfoList(catalog.get(next)?.require).ids);
      }
      requireClosure.set(a, seen);
    }
    return requireClosure.get(a).has(b);
  };
  const declaresAfter = (a, b) =>
    listOf(catalog.get(a)?.loadAfter).includes(b) || listOf(catalog.get(b)?.loadBefore).includes(a);
  const ruleWinner = new Map();
  for (const rule of usableOrderRules(rules)) {
    ruleWinner.set(`${rule.before}\u0000${rule.after}`, rule);
  }
  return {
    catalog,
    classification: classification instanceof Map ? classification : new Map(),
    fileCounts: fileCounts instanceof Map ? fileCounts : new Map(),
    modIdOrder: modIdOrder instanceof Map ? modIdOrder : new Map(),
    position: new Map((Array.isArray(effectiveOrder) ? effectiveOrder : []).map((id, i) => [id, i])),
    requiresTransitively,
    declaresAfter,
    ruleFor: (before, after) => ruleWinner.get(`${before}\u0000${after}`),
  };
}

function isTranslationFile(file) {
  return file?.kind === "translation-override" || file?.category === "translate";
}

/**
 * The suggested winner of one scan pair ({ modA, modB, files, aWins, bWins }),
 * or null when nothing points either way.
 */
export function suggestConflictWinner(pair, ctx) {
  const a = pair?.modA?.modId;
  const b = pair?.modB?.modId;
  if (typeof a !== "string" || typeof b !== "string" || a === b) return null;
  const files = Array.isArray(pair.files) ? pair.files : [];
  if (files.length > 0 && files.every((f) => f?.kind === "declared-incompatible")) return null;

  const pick = (winner, confidence, reason, params) => {
    const loser = winner === a ? b : a;
    const posWinner = ctx.position.get(winner);
    const posLoser = ctx.position.get(loser);
    let alreadyWinning;
    if (posWinner !== undefined && posLoser !== undefined) alreadyWinning = posWinner > posLoser;
    else alreadyWinning = (winner === a ? pair.aWins : pair.bWins) > 0 && (winner === a ? pair.bWins : pair.aWins) === 0;
    return { winner, confidence, reason, alreadyWinning, ...(params ? { params } : {}) };
  };

  const ruleAB = ctx.ruleFor(a, b);
  const ruleBA = ctx.ruleFor(b, a);
  if (ruleAB && !ruleBA) return pick(b, "high", "rule", { ruleId: ruleAB.id });
  if (ruleBA && !ruleAB) return pick(a, "high", "rule", { ruleId: ruleBA.id });

  const aNeedsB = ctx.requiresTransitively(a, b);
  const bNeedsA = ctx.requiresTransitively(b, a);
  if (aNeedsB !== bNeedsA) return pick(aNeedsB ? a : b, "high", "requiresOther");

  const aAfterB = ctx.declaresAfter(a, b);
  const bAfterA = ctx.declaresAfter(b, a);
  if (aAfterB !== bAfterA) return pick(aAfterB ? a : b, "high", "declaresLoadAfter");

  const ca = ctx.classification.get(a);
  const cb = ctx.classification.get(b);
  const aPatchesB = (ca?.patchOf || []).includes(b);
  const bPatchesA = (cb?.patchOf || []).includes(a);
  if (aPatchesB !== bPatchesA) {
    const info = aPatchesB ? ca : cb;
    return pick(aPatchesB ? a : b, info.confidence || "medium", "patchOfOther");
  }

  if (files.length > 0 && files.every(isTranslationFile)) {
    const aTr = ca?.kind === "translation";
    const bTr = cb?.kind === "translation";
    if (aTr !== bTr) return pick(aTr ? a : b, "medium", "translation");
  }

  const fa = ctx.fileCounts.get(a);
  const fb = ctx.fileCounts.get(b);
  if (Number.isFinite(fa) && Number.isFinite(fb) && fa > 0 && fb > 0) {
    const L = CONFLICT_SUGGESTION_LIMITS;
    const [small, fs, fbig] = fa <= fb ? [a, fa, fb] : [b, fb, fa];
    const conflicting = new Set(files.map((f) => f?.file)).size;
    if (fs <= L.smallMaxFiles && conflicting / fs >= L.smallConflictShare && fbig >= fs * L.bigFactor) {
      return pick(small, "medium", "smallOverride", { files: fs, conflicting: Math.min(conflicting, fs), otherFiles: fbig });
    }
  }

  const wsA = ctx.catalog.get(a)?.workshopId;
  const wsB = ctx.catalog.get(b)?.workshopId;
  if (wsA && wsA === wsB) {
    const listed = ctx.modIdOrder.get(wsA) || [];
    const ia = listed.indexOf(a);
    const ib = listed.indexOf(b);
    if (ia !== -1 && ib !== -1) return pick(ia > ib ? a : b, "low", "sameWorkshopItem", { workshopId: wsA });
  }
  return null;
}

/** `pairs` with `suggestion` set on each pair that has a signal (copies). */
export function suggestConflictWinners(pairs, ctx) {
  return (Array.isArray(pairs) ? pairs : []).map((pair) => {
    const { suggestion: _old, ...rest } = pair || {};
    const suggestion = suggestConflictWinner(rest, ctx);
    return suggestion ? { ...rest, suggestion } : rest;
  });
}
