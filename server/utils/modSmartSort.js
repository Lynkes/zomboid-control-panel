// The load-order planner ("smart sort"): from a Mods= order and everything
// the panel knows about the mods, the best order and why every mod is where it
// is. Pure: the route gathers the inputs (routes/modsSmart.js).
//
// Constraints (`before` loads before `after`), strongest first:
//   hard    require        `after` require=s `before` (the game enforces it;
//                          also through a required mod that Mods= does not
//                          list, `via` names it)
//           rule           an admin's order rule (utils/modOrderRules.js)
//           groupOrder     two members of a mod group, in the group's order
//   (keepTogether: a group kept together is one block; ranks here)
//   strong  loadAfter / loadBefore   declared in mod.info (the server ignores
//                          them, the main menu's sort uses them)
//           steamRequired  a Workshop item's "Required items": the required
//                          item's mods before the dependent item's mods
//           patch          a patch after the mod it patches (classification,
//                          or named like one)
//           conflictWinner keeps the current winner of a high conflict
//   soft    tier (tiered mode only) and the current order
//
// Algorithm: the constraints between the given mods form a graph whose nodes
// are mods, or whole blocks for groups kept together (members in the group's
// order, fixed). Every strongly connected component is a contradiction: the
// weakest constraints in it are dropped (those the current order already
// breaks first, so the order is kept where the inputs disagree) and reported;
// require= is dropped only when the loop is all require= (the game's loader
// overflows its stack on such a loop: `gameCrash`). A block whose own members
// can only be satisfied by putting another mod between them is split instead.
// Then the order is built the way the game loads mods: in the current order
// (in tiered mode by tier first; groups placed "first"/"last" before/after
// the rest), each mod is placed right after everything it must follow,
// pulling those forward. So a mod nothing constrains never changes places
// relative to the others, require= violations end up exactly where the game
// already loads them, and planning the result again changes nothing.

import { computeOrderingConstraints, normaliseModInfoList } from "./modLoadOrder.js";
import { usableOrderRules } from "./modOrderRules.js";
import { keepTogetherForcedApart } from "./modGroups.js";

export const CONSTRAINT_REASONS = Object.freeze({
  require: Object.freeze({ strength: "hard", rank: 0 }),
  rule: Object.freeze({ strength: "hard", rank: 1 }),
  groupOrder: Object.freeze({ strength: "hard", rank: 2 }),
  loadAfter: Object.freeze({ strength: "strong", rank: 4 }),
  loadBefore: Object.freeze({ strength: "strong", rank: 4 }),
  steamRequired: Object.freeze({ strength: "strong", rank: 5 }),
  patch: Object.freeze({ strength: "strong", rank: 6 }),
  conflictWinner: Object.freeze({ strength: "strong", rank: 7 }),
});

// Keeping a group together sits between groupOrder and loadAfter.
const KEEP_TOGETHER_RANK = 3;

export const SMART_SORT_LIMITS = Object.freeze({
  maxMods: 5000,
  maxConstraints: 50_000,
  maxSteamEdges: 5000,
  maxRequireWalk: 2000,
  maxCycleReports: 200,
  maxCycleMods: 50,
  maxExplanationsPerMod: 50,
  maxMoveReasons: 10,
});

const PLACEMENT_RANK = { first: 0, last: 2 };
const HIGH_REASONS = new Set(["require", "rule", "groupOrder", "keepTogether", "groupPlacement", "loadAfter", "loadBefore"]);
const MEDIUM_REASONS = new Set(["steamRequired", "conflictWinner"]);

function rankOf(reason) {
  return CONSTRAINT_REASONS[reason]?.rank ?? 99;
}

function uniqueIds(list, max = SMART_SORT_LIMITS.maxMods) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(list) ? list : []) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function toCatalog(mods) {
  const catalog = new Map();
  for (const mod of Array.isArray(mods) ? mods : []) {
    if (mod && typeof mod.id === "string" && mod.id && !catalog.has(mod.id)) catalog.set(mod.id, mod);
  }
  return catalog;
}

function groupMembers(group, present) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(group?.modIds) ? group.modIds : []) {
    if (typeof id !== "string" || seen.has(id) || !present.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Every constraint between the mods of `order`, from what the panel knows:
 *   mods             catalog: [{ id, name?, workshopId?, require?, loadAfter?,
 *                    loadBefore? }] (the first entry for an id wins)
 *   classification   classifyMods() result (patchOf), optional
 *   rules            stored order rules
 *   groups           stored mod groups (groupOrder between present members)
 *   steamRequires    Map<workshopId, requiredWorkshopId[]> (known items only)
 *   conflictPairs    [[modA, modB]] that ship the same files: the one later
 *                    in `order` (today's winner) stays after the other
 *   conflictWinners  [{ winner, loser }] decided elsewhere
 * Returns { order, constraints, missing, implicit }:
 *   constraints  [{ before, after, reason, strength, reasons?, declaredBy?,
 *                via?, ruleId?, group?, workshopId?, requiresWorkshopId?,
 *                source?, confidence? }]
 *   missing      require= links to a mod that is not in `order`
 *                [{ before, after, reason: "require", why: "missingMod",
 *                loadedImplicitly }]
 *   implicit     [{ modId, requiredBy }] required mods the game loads
 *                although `order` does not list them (installed)
 */
export function buildLoadOrderConstraints(input = {}) {
  const ids = uniqueIds(input.order);
  const present = new Set(ids);
  const catalog = toCatalog(input.mods);
  const edges = new Map();
  let count = 0;
  const add = (before, after, reason, extra = {}) => {
    if (!present.has(before) || !present.has(after) || before === after) return;
    const key = `${before}\u0000${after}`;
    const existing = edges.get(key);
    if (!existing) {
      if (count >= SMART_SORT_LIMITS.maxConstraints) return;
      count++;
      edges.set(key, { before, after, reason, strength: CONSTRAINT_REASONS[reason].strength, reasons: [reason], ...extra });
      return;
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (rankOf(reason) < rankOf(existing.reason)) {
      for (const field of ["declaredBy", "via", "ruleId", "group", "groupIndex", "workshopId", "requiresWorkshopId", "source", "confidence"]) {
        delete existing[field];
      }
      Object.assign(existing, extra, { reason, strength: CONSTRAINT_REASONS[reason].strength });
    }
  };

  // require=, also through required mods Mods= does not list (the game loads
  // those first, so their own dependencies come before the mod as well).
  const requireIds = (id) => normaliseModInfoList(catalog.get(id)?.require).ids;
  const missing = [];
  const implicit = new Map();
  for (const modId of ids) {
    if (!catalog.has(modId)) continue;
    const visited = new Set([modId]);
    const stack = requireIds(modId).map((dep) => ({ dep, via: null }));
    let walked = 0;
    while (stack.length > 0 && walked < SMART_SORT_LIMITS.maxRequireWalk) {
      const { dep, via } = stack.pop();
      if (visited.has(dep)) continue;
      visited.add(dep);
      walked++;
      if (present.has(dep)) {
        add(dep, modId, "require", { declaredBy: via || modId, ...(via ? { via } : {}) });
        continue;
      }
      const installed = catalog.has(dep);
      if (!via) missing.push({ before: dep, after: modId, reason: "require", why: "missingMod", loadedImplicitly: installed });
      if (!installed) continue;
      if (!implicit.has(dep)) implicit.set(dep, []);
      if (!implicit.get(dep).includes(modId)) implicit.get(dep).push(modId);
      for (const next of requireIds(dep)) stack.push({ dep: next, via: via || dep });
    }
  }

  // loadModAfter=, loadModBefore=, name-guessed patches, current winners.
  const presentMods = ids.map((id) => catalog.get(id)).filter(Boolean);
  for (const edge of computeOrderingConstraints(presentMods)) {
    for (const reason of edge.reasons || [edge.reason]) {
      if (reason === "require") continue;
      const extra = {};
      if (edge.declaredBy) extra.declaredBy = edge.declaredBy;
      if (reason === "patch") Object.assign(extra, { source: "name", confidence: "low" });
      add(edge.before, edge.after, reason, extra);
    }
  }

  // Patches the classifier recognised.
  if (input.classification instanceof Map) {
    for (const [modId, info] of input.classification) {
      for (const target of info?.patchOf || []) {
        add(target, modId, "patch", { source: "classification", confidence: info.confidence || "medium" });
      }
    }
  }

  for (const rule of usableOrderRules(input.rules)) {
    add(rule.before, rule.after, "rule", { ruleId: rule.id });
  }

  // Group order; a group earlier in the list wins over a later one that
  // orders the same two mods the other way (groupIndex).
  (Array.isArray(input.groups) ? input.groups : []).forEach((group, groupIndex) => {
    const members = groupMembers(group, present);
    for (let i = 0; i + 1 < members.length; i++) {
      add(members[i], members[i + 1], "groupOrder", { group: String(group?.id ?? ""), groupIndex });
    }
  });

  // Steam "Required items", item level.
  if (input.steamRequires instanceof Map) {
    const itemMods = new Map();
    for (const id of ids) {
      const wsId = catalog.get(id)?.workshopId;
      if (typeof wsId !== "string" || !wsId) continue;
      if (!itemMods.has(wsId)) itemMods.set(wsId, []);
      itemMods.get(wsId).push(id);
    }
    let steamEdges = 0;
    outer: for (const [wsId, dependents] of itemMods) {
      for (const requiredWsId of input.steamRequires.get(wsId) || []) {
        if (requiredWsId === wsId || !itemMods.has(requiredWsId)) continue;
        // "Required items" is a subscribe list, not a load order: two items
        // that list each other (a mod and its compatibility pack) say nothing
        // about order.
        if ((input.steamRequires.get(requiredWsId) || []).includes(wsId)) continue;
        for (const before of itemMods.get(requiredWsId)) {
          for (const after of dependents) {
            // The mods' own rules (require=, loadModAfter, a rule, a group)
            // win: never add the opposite of one only to drop it in a loop.
            if (edges.has(`${after}\u0000${before}`)) continue;
            if (steamEdges++ >= SMART_SORT_LIMITS.maxSteamEdges) break outer;
            add(before, after, "steamRequired", { workshopId: wsId, requiresWorkshopId: requiredWsId });
          }
        }
      }
    }
  }

  // Today's conflict winners: the weakest constraint, added last so it only
  // joins a pair other reasons already order the same way, and is reported
  // when a stronger one orders the pair the other way.
  const position = new Map(ids.map((id, i) => [id, i]));
  for (const pair of Array.isArray(input.conflictPairs) ? input.conflictPairs : []) {
    if (!Array.isArray(pair) || !present.has(pair[0]) || !present.has(pair[1])) continue;
    const [loser, winner] = position.get(pair[0]) < position.get(pair[1]) ? [pair[0], pair[1]] : [pair[1], pair[0]];
    add(loser, winner, "conflictWinner");
  }
  for (const entry of Array.isArray(input.conflictWinners) ? input.conflictWinners : []) {
    if (entry && typeof entry.winner === "string" && typeof entry.loser === "string") add(entry.loser, entry.winner, "conflictWinner");
  }

  const constraints = [...edges.values()].map((edge) => {
    if (edge.reasons.length < 2) delete edge.reasons;
    else edge.reasons.sort((a, b) => rankOf(a) - rankOf(b));
    return edge;
  });
  constraints.sort(
    (a, b) =>
      rankOf(a.reason) - rankOf(b.reason) ||
      (a.after < b.after ? -1 : a.after > b.after ? 1 : 0) ||
      (a.before < b.before ? -1 : a.before > b.before ? 1 : 0),
  );
  return {
    order: ids,
    constraints,
    missing,
    implicit: [...implicit].map(([modId, requiredBy]) => ({ modId, requiredBy })),
  };
}

// ─── Graph helpers ────────────────────────────────────────────────────────

// Strongly connected components of sub-graphs of one graph (`nodeCount`
// nodes, `outEdges[node]` = indices into `edges` of { to, alive }), following
// alive edges only. Iterative Tarjan over typed arrays, the workspace shared
// by every call. `scc(nodes)` returns the components of the sub-graph on
// `nodes` that have more than one node.
function createScc(nodeCount, outEdges, edges) {
  const indexOf = new Int32Array(nodeCount);
  const low = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const inSet = new Int32Array(nodeCount);
  const workNode = new Int32Array(nodeCount);
  const workEdge = new Int32Array(nodeCount);
  const stack = new Int32Array(nodeCount);
  let generation = 0;
  return function scc(nodes) {
    generation++;
    for (const v of nodes) {
      inSet[v] = generation;
      indexOf[v] = -1;
    }
    const components = [];
    let counter = 0;
    let top = 0;
    for (const start of nodes) {
      if (indexOf[start] !== -1) continue;
      let depth = 0;
      workNode[0] = start;
      workEdge[0] = 0;
      indexOf[start] = low[start] = counter++;
      stack[top++] = start;
      onStack[start] = 1;
      while (depth >= 0) {
        const node = workNode[depth];
        const out = outEdges[node];
        let descended = false;
        while (workEdge[depth] < out.length) {
          const edge = edges[out[workEdge[depth]++]];
          const next = edge.to;
          if (!edge.alive || inSet[next] !== generation) continue;
          if (indexOf[next] === -1) {
            indexOf[next] = low[next] = counter++;
            stack[top++] = next;
            onStack[next] = 1;
            depth++;
            workNode[depth] = next;
            workEdge[depth] = 0;
            descended = true;
            break;
          }
          if (onStack[next] && indexOf[next] < low[node]) low[node] = indexOf[next];
        }
        if (descended) continue;
        depth--;
        if (depth >= 0) {
          const parent = workNode[depth];
          if (low[node] < low[parent]) low[parent] = low[node];
        }
        if (low[node] === indexOf[node]) {
          let size = 0;
          const component = [];
          let member;
          do {
            member = stack[--top];
            onStack[member] = 0;
            component.push(member);
            size++;
          } while (member !== node);
          if (size > 1) components.push(component);
        }
      }
    }
    return components;
  };
}

function stronglyConnected(nodes, outEdges, edges) {
  return createScc(outEdges.length, outEdges, edges)(nodes);
}

/**
 * Plans the load order.
 *
 * @param {object} input
 * @param {string[]} input.order        the current Mods= order
 * @param {Array} input.constraints     buildLoadOrderConstraints().constraints
 * @param {Array} [input.groups]        stored groups ({ id, name, modIds,
 *                                      keepTogether, placement })
 * @param {boolean} [input.useGroups]   default true
 * @param {"minimal"|"tiered"} [input.mode]  default "minimal"
 * @param {Map} [input.classification]  classifyMods() (tier, kind)
 * @param {Array} [input.missing]       buildLoadOrderConstraints().missing
 * @param {Array} [input.implicit]      buildLoadOrderConstraints().implicit
 * @returns the POST /mods/load-order/plan response (see routes/modsSmart.js)
 */
export function planLoadOrder(input = {}) {
  const started = performance.now();
  const rawOrder = Array.isArray(input.order) ? input.order.filter((id) => typeof id === "string" && id) : [];
  const ids = uniqueIds(rawOrder);
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const tiered = input.mode === "tiered";
  const groups = input.useGroups !== false && Array.isArray(input.groups) ? input.groups : [];
  const groupById = new Map(groups.map((g) => [String(g?.id ?? ""), g]));
  const classification = input.classification instanceof Map ? input.classification : new Map();

  // Loops are broken where the current order already disagrees, and the
  // order is the best of a few candidates; both can make the plan of a plan
  // differ in rare shapes. Planning the result again until it holds makes
  // the answer a fixed point: applying it and planning again changes nothing.
  let solved = solve(input, ids);
  for (let round = 0; round < 6 && solved.needsCheck; round++) {
    const again = solve(input, solved.result);
    const same = again.result.every((id, i) => id === solved.result[i]);
    solved = again;
    if (same) break;
  }
  const { result, constraints, cycles, warnings, unitOfMod, units, isConstrained } = solved;
  const position = new Map(result.map((id, i) => [id, i]));
  const violatedInInput = (c) => index.get(c.before) > index.get(c.after);

  // ── What holds, what does not ──
  let satisfied = 0;
  const unsatisfied = [];
  const winnersChanged = [];
  for (const c of constraints) {
    if (position.get(c.before) < position.get(c.after)) {
      satisfied++;
      continue;
    }
    // A Steam "Required items" hint the mods' own rules overrule is not a
    // problem to report (the owner saw six such "could not be met" lines).
    if (c.reason === "steamRequired") continue;
    const why = c.state === "harder" || c.state === "placement" ? "conflictsWithHarder" : "cycle";
    const by = c.state === "placement" ? "groupPlacement" : c.by;
    unsatisfied.push({
      before: c.before,
      after: c.after,
      reason: c.reason,
      why,
      ...(by ? { by } : {}),
      ...(c.group !== undefined ? { group: c.group } : {}),
      ...(c.ruleId !== undefined ? { ruleId: c.ruleId } : {}),
    });
    if (c.reason === "conflictWinner" || c.reasons?.includes("conflictWinner")) {
      winnersChanged.push({ previousWinner: c.after, newWinner: c.before, why, ...(by ? { by } : {}) });
    }
  }
  for (const m of Array.isArray(input.missing) ? input.missing : []) {
    if (!index.has(m?.after)) continue;
    unsatisfied.push({
      before: m.before,
      after: m.after,
      reason: m.reason || "require",
      why: "missingMod",
      ...(m.loadedImplicitly ? { loadedImplicitly: true } : {}),
    });
  }

  // ── Explanations ──
  const describe = (c, modId) => {
    const params = { relation: modId === c.after ? "after" : "before", other: modId === c.after ? c.before : c.after };
    for (const field of ["via", "ruleId", "group", "workshopId", "requiresWorkshopId", "source", "confidence"]) {
      if (c[field] !== undefined) params[field] = c[field];
    }
    if (params.group !== undefined) params.groupName = String(groupById.get(params.group)?.name ?? "");
    return { code: c.reason, params };
  };
  // No prototype: mod ids such as "constructor" are keys here.
  const explanations = Object.create(null);
  const pushExplanation = (modId, entry) => {
    if (!explanations[modId]) explanations[modId] = [];
    if (explanations[modId].length < SMART_SORT_LIMITS.maxExplanationsPerMod) explanations[modId].push(entry);
  };
  const activeOf = new Map();
  for (const c of constraints) {
    if (c.state !== "active" || position.get(c.before) > position.get(c.after)) continue;
    for (const modId of [c.after, c.before]) {
      if (!activeOf.has(modId)) activeOf.set(modId, []);
      activeOf.get(modId).push(c);
    }
  }
  const groupNotes = (modId, { onlyIfApart = false } = {}) => {
    const notes = [];
    const unit = units[unitOfMod.get(modId)];
    if (unit?.group && (!onlyIfApart || unit.apartIn(index))) {
      notes.push({ code: "keepTogether", params: { group: String(unit.group.id), groupName: String(unit.group.name ?? "") } });
    }
    if (unit && unit.placement !== 1) {
      for (const group of unit.placementGroups) {
        if ((group.placement === "first") === (unit.placement === 0)) {
          notes.push({ code: "groupPlacement", params: { group: String(group.id), groupName: String(group.name ?? ""), placement: group.placement } });
        }
      }
    }
    return notes;
  };
  const tierNote = (modId) => {
    if (!tiered || !classification.has(modId)) return [];
    const info = classification.get(modId);
    return [{ code: "tier", params: { tier: info.tier, kind: info.kind } }];
  };
  for (const id of result) {
    for (const c of (activeOf.get(id) || []).sort((a, b) => a.rank - b.rank)) pushExplanation(id, describe(c, id));
    for (const note of groupNotes(id)) pushExplanation(id, note);
    for (const note of tierNote(id)) pushExplanation(id, note);
  }

  // ── Moves: the fewest mods that explain the change. A mod no constraint,
  // block, placement or tier names weighs more than all the others together,
  // so it is never one of them. ──
  const kept = keptInPlace(result, index, (id) => (isConstrained(id) ? 1 : n + 1));
  const moved = new Set(result.filter((id) => !kept.has(id)));
  const moves = [];
  for (let to = 0; to < result.length; to++) {
    const modId = result[to];
    if (!moved.has(modId)) continue;
    const reasons = (activeOf.get(modId) || [])
      .filter((c) => violatedInInput(c) || moved.has(c.before === modId ? c.after : c.before))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, SMART_SORT_LIMITS.maxMoveReasons)
      .map((c) => describe(c, modId));
    reasons.push(...groupNotes(modId, { onlyIfApart: true }), ...tierNote(modId));
    if (reasons.length === 0) reasons.push({ code: "displaced", params: {} });
    moves.push({ modId, from: index.get(modId), to, reasons, confidence: moveConfidence(reasons) });
  }

  let hard = 0;
  let strong = 0;
  for (const c of constraints) {
    if (c.strength === "hard") hard++;
    else strong++;
  }
  const changed = result.length !== rawOrder.length || result.some((id, i) => id !== rawOrder[i]);
  return {
    order: result,
    changed,
    moves,
    explanations,
    satisfied,
    unsatisfied,
    cycles,
    winnersChanged,
    implicit: Array.isArray(input.implicit) ? input.implicit.filter((m) => m && typeof m.modId === "string") : [],
    warnings,
    stats: {
      constraints: constraints.length,
      hard,
      strong,
      soft: tiered ? n : 0,
      ms: Math.round((performance.now() - started) * 10) / 10,
    },
  };
}

// A group earlier in the list orders a pair before a later group does.
function rankValue(c) {
  return rankOf(c.reason) + (c.reason === "groupOrder" && Number.isInteger(c.groupIndex) ? Math.min(c.groupIndex, 9999) * 1e-4 : 0);
}

// One pass: the constraints between `ids`, loops broken (where `ids`, the
// order this pass starts from, already disagrees), blocks, placement, then
// the order.
function solve(input, ids) {
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const tiered = input.mode === "tiered";
  const useGroups = input.useGroups !== false;
  const classification = input.classification instanceof Map ? input.classification : new Map();
  const groups = useGroups && Array.isArray(input.groups) ? input.groups : [];
  const warnings = [];

  // ── Constraints between the given mods ──
  const byKey = new Map();
  for (const raw of Array.isArray(input.constraints) ? input.constraints : []) {
    if (!raw || !CONSTRAINT_REASONS[raw.reason]) continue;
    if (!index.has(raw.before) || !index.has(raw.after) || raw.before === raw.after) continue;
    if (!useGroups && raw.reason === "groupOrder") continue;
    const key = `${raw.before}\u0000${raw.after}`;
    const rank = rankValue(raw);
    const existing = byKey.get(key);
    if (existing && existing.rank <= rank) continue;
    byKey.set(key, { ...raw, strength: CONSTRAINT_REASONS[raw.reason].strength, rank, state: "active" });
    if (byKey.size >= SMART_SORT_LIMITS.maxConstraints) break;
  }
  const constraints = [...byKey.values()];
  // A pair constrained both ways: the weaker side yields to the stronger.
  for (const c of constraints) {
    const reverse = byKey.get(`${c.after}\u0000${c.before}`);
    if (reverse && reverse.rank < c.rank) {
      c.state = "harder";
      c.by = reverse.reason;
    }
  }
  const violatedInInput = (c) => index.get(c.before) > index.get(c.after);

  // ── Groups: blocks kept together, placement ──
  const placementGroupsOf = new Map(); // modId -> [group] with a placement
  const blockGroups = [];
  const claimedBy = new Map();
  for (const group of groups) {
    const present = groupMembers(group, index);
    if (PLACEMENT_RANK[group?.placement] !== undefined) {
      for (const id of present) {
        if (!placementGroupsOf.has(id)) placementGroupsOf.set(id, []);
        placementGroupsOf.get(id).push(group);
      }
    }
    if (group?.keepTogether !== true) continue;
    const members = [];
    for (const id of present) {
      if (claimedBy.has(id)) {
        warnings.push({
          code: "inTwoKeepTogetherGroups",
          params: { modId: id, group: String(claimedBy.get(id).id), otherGroup: String(group.id) },
        });
        continue;
      }
      claimedBy.set(id, group);
      members.push(id);
    }
    if (members.length >= 2) blockGroups.push({ group, members });
  }

  const cycles = [];
  let cycleReports = 0;
  const reportDrop = (componentMods, dropped, gameCrash) => {
    let mods = null;
    for (const c of dropped) {
      c.state = "cycle";
      if (c.reason === "steamRequired") continue; // a hint, see unsatisfied
      if (cycleReports >= SMART_SORT_LIMITS.maxCycleReports) continue;
      cycleReports++;
      if (!mods) mods = [...componentMods].sort((a, b) => index.get(a) - index.get(b)).slice(0, SMART_SORT_LIMITS.maxCycleMods);
      cycles.push({
        mods,
        droppedEdge: { before: c.before, after: c.after, reason: c.reason },
        ...(gameCrash ? { gameCrash: true } : {}),
      });
    }
  };

  // Breaks every loop among `nodes` (indices into `nodeMods`) over `edges`
  // ({ from, to, alive, members, rank }): in each strongly connected
  // component the weakest constraints go, the ones the current order already
  // breaks first. Returns the components that could only be solved by
  // splitting a block (when `canSplit(component, weakest)`).
  function breakCycles(nodeCount, nodes, edges, nodeMods, canSplit) {
    const outEdges = Array.from({ length: nodeCount }, () => []);
    edges.forEach((edge, i) => outEdges[edge.from].push(i));
    const scc = createScc(nodeCount, outEdges, edges);
    const mark = new Int32Array(nodeCount);
    let markGeneration = 0;
    const work = [nodes];
    const splits = [];
    let guard = 0;
    while (work.length > 0 && guard++ < 100_000) {
      const set = work.pop();
      for (const component of scc(set)) {
        markGeneration++;
        for (const node of component) mark[node] = markGeneration;
        // Weakest first, constraint by constraint: an edge between two units
        // can carry a strong constraint and a weak one at once.
        const internal = [];
        let weakest = -1;
        for (const node of component) {
          for (const e of outEdges[node]) {
            const edge = edges[e];
            if (!edge.alive || mark[edge.to] !== markGeneration) continue;
            internal.push(edge);
            for (const c of edge.members) if (c.state === "active" && c.rank > weakest) weakest = c.rank;
          }
        }
        if (internal.length === 0) continue;
        if (canSplit && canSplit(component, weakest)) {
          splits.push(component);
          continue;
        }
        const candidates = [];
        for (const edge of internal) for (const c of edge.members) if (c.state === "active" && c.rank === weakest) candidates.push(c);
        let drop = candidates.filter(violatedInInput);
        // None of the weakest is broken by the current order (the order breaks
        // a stronger one): drop one of them at a time in a small loop, all of
        // them in a big tangle (one at a time there is quadratic).
        if (drop.length === 0 && candidates.length > 8) drop = candidates;
        if (drop.length === 0) {
          drop = [candidates.reduce((best, c) => (c.before < best.before || (c.before === best.before && c.after < best.after) ? c : best))];
        }
        const componentMods = cycleReports < SMART_SORT_LIMITS.maxCycleReports ? component.flatMap((node) => nodeMods[node]) : [];
        reportDrop(componentMods, drop, Math.floor(weakest) === 0);
        for (const edge of internal) edge.alive = edge.members.some((c) => c.state === "active");
        work.push(component);
      }
    }
    return splits;
  }

  // Mods that load between members of a block: reachable from a member and
  // reaching a member, over the constraints still standing.
  function modsBetween(members, scope) {
    const inScope = new Set(scope);
    const isMember = new Set(members);
    const succ = new Map();
    const pred = new Map();
    for (const c of constraints) {
      if (c.state !== "active" || !inScope.has(c.before) || !inScope.has(c.after)) continue;
      if (!succ.has(c.before)) succ.set(c.before, []);
      succ.get(c.before).push(c.after);
      if (!pred.has(c.after)) pred.set(c.after, []);
      pred.get(c.after).push(c.before);
    }
    const walk = (adjacency) => {
      const seen = new Set();
      const stack = [...members];
      while (stack.length > 0) {
        for (const next of adjacency.get(stack.pop()) || []) {
          if (isMember.has(next) || seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      return seen;
    };
    const down = walk(succ);
    const up = walk(pred);
    return [...down].filter((id) => up.has(id)).sort((a, b) => index.get(a) - index.get(b));
  }

  // ── Units: a block per group kept together, else one mod each ──
  // A group kept together yields to hard constraints: the rule shared with
  // the group enforcement of POST /save-order (modGroups.js
  // keepTogetherForcedApart), so saving a plan never gathers a group the
  // plan had to split.
  const forcedApart = keepTogetherForcedApart(
    ids,
    groups,
    (Array.isArray(input.constraints) ? input.constraints : []).filter(
      (c) => c && (c.reason === "require" || c.reason === "rule") && index.has(c.before) && index.has(c.after),
    ),
  );
  const blocks = blockGroups.map((b) => ({ ...b, split: forcedApart.has(b.group?.id) }));
  for (const block of blocks) {
    if (!block.split) continue;
    warnings.push({
      code: "keepTogetherBroken",
      params: {
        group: String(block.group.id),
        groupName: String(block.group.name ?? ""),
        mods: forcedApart.get(block.group.id).slice(0, SMART_SORT_LIMITS.maxCycleMods),
      },
    });
  }
  let units;
  let unitOf;
  for (let attempt = 0; attempt <= blocks.length; attempt++) {
    units = [];
    unitOf = new Map();
    for (const block of blocks) {
      if (block.split) continue;
      for (const id of block.members) unitOf.set(id, units.length);
      units.push({ members: block.members, group: block.group });
    }
    for (const id of ids) {
      if (unitOf.has(id)) continue;
      unitOf.set(id, units.length);
      units.push({ members: [id], group: null });
    }

    // Each block's own order: its members in the group's order, adjusted to
    // the constraints between them (a contradiction drops the weaker side).
    for (const unit of units) {
      if (!unit.group) continue;
      const local = new Map(unit.members.map((id, i) => [id, i]));
      const memberEdges = new Map();
      for (const c of constraints) {
        if (c.state !== "active" || !local.has(c.before) || !local.has(c.after)) continue;
        const key = `${local.get(c.before)}:${local.get(c.after)}`;
        if (!memberEdges.has(key)) {
          memberEdges.set(key, { from: local.get(c.before), to: local.get(c.after), alive: true, members: [], rank: 99 });
        }
        const edge = memberEdges.get(key);
        edge.members.push(c);
        edge.rank = Math.min(edge.rank, c.rank);
      }
      const edgeList = [...memberEdges.values()];
      breakCycles(unit.members.length, unit.members.map((_, i) => i), edgeList, unit.members.map((id) => [id]), null);
      unit.members = pullUpOrder(
        unit.members.length,
        edgeList.filter((e) => e.alive),
        unit.members.map((_, i) => [i]),
      ).map((i) => unit.members[i]);
    }

    // The graph between units.
    const unitEdges = new Map();
    for (const c of constraints) {
      if (c.state !== "active") continue;
      const from = unitOf.get(c.before);
      const to = unitOf.get(c.after);
      if (from === to) continue;
      const key = `${from}:${to}`;
      if (!unitEdges.has(key)) unitEdges.set(key, { from, to, alive: true, members: [], rank: 99 });
      const edge = unitEdges.get(key);
      edge.members.push(c);
      edge.rank = Math.min(edge.rank, c.rank);
    }
    const edgeList = [...unitEdges.values()];
    // A loop between units that disappears when its blocks are taken apart is
    // made by keeping a group together, not by the constraints themselves.
    // Only when every constraint in the loop is stronger than keeping the
    // group together (require=, rules, group order); a weaker one is dropped.
    const splitHelps = (component, weakest) => {
      if (weakest >= KEEP_TOGETHER_RANK || !component.some((u) => units[u].group)) return false;
      const mods = component.flatMap((u) => units[u].members);
      const local = new Map(mods.map((id, i) => [id, i]));
      const memberEdges = [];
      for (const c of constraints) {
        if (c.state === "active" && local.has(c.before) && local.has(c.after)) {
          memberEdges.push({ from: local.get(c.before), to: local.get(c.after), alive: true });
        }
      }
      const outEdges = Array.from({ length: mods.length }, () => []);
      memberEdges.forEach((edge, i) => outEdges[edge.from].push(i));
      return stronglyConnected(mods.map((_, i) => i), outEdges, memberEdges).length === 0;
    };
    const splits = breakCycles(
      units.length,
      units.map((_, i) => i),
      edgeList,
      units.map((u) => u.members),
      splitHelps,
    );
    units.edges = edgeList.filter((e) => e.alive);
    if (splits.length === 0) break;
    for (const component of splits) {
      const scope = component.flatMap((v) => units[v].members);
      for (const u of component) {
        const unit = units[u];
        if (!unit.group) continue;
        const block = blocks.find((b) => b.group === unit.group);
        if (block && !block.split) {
          block.split = true;
          warnings.push({
            code: "keepTogetherBroken",
            params: {
              group: String(unit.group.id),
              groupName: String(unit.group.name ?? ""),
              mods: modsBetween(unit.members, scope).slice(0, SMART_SORT_LIMITS.maxCycleMods),
            },
          });
        }
      }
    }
  }

  // ── Placement: a group placed "first" loads before everything else with
  // what it needs; one placed "last" after everything else with what needs
  // it. A mod a "first" mod needs is never last (reported). ──
  const count = units.length;
  const preds = Array.from({ length: count }, () => []);
  const succs = Array.from({ length: count }, () => []);
  for (const edge of units.edges) {
    // Today's conflict winners never drag a mod first or last.
    if (edge.members.every((c) => c.reason === "conflictWinner")) continue;
    preds[edge.to].push(edge.from);
    succs[edge.from].push(edge.to);
  }
  const seedOf = units.map((unit) => {
    let first = false;
    let last = false;
    const placementGroups = [];
    const consider = (group) => {
      if (!group || placementGroups.includes(group)) return;
      placementGroups.push(group);
      if (group.placement === "first") first = true;
      if (group.placement === "last") last = true;
    };
    if (unit.group && PLACEMENT_RANK[unit.group.placement] !== undefined) consider(unit.group);
    for (const id of unit.members) for (const group of placementGroupsOf.get(id) || []) consider(group);
    unit.placementGroups = placementGroups;
    return { first, last };
  });
  const closure = (starts, adjacency) => {
    const seen = new Set(starts);
    const stack = [...starts];
    while (stack.length > 0) {
      for (const next of adjacency[stack.pop()]) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  };
  const firstSet = closure(
    seedOf.map((s, u) => (s.first ? u : -1)).filter((u) => u !== -1),
    preds,
  );
  const lastSeeds = seedOf.map((s, u) => (s.last && !firstSet.has(u) ? u : -1)).filter((u) => u !== -1);
  const lastSet = closure(lastSeeds, succs);
  const placementConflicts = [];
  units.forEach((unit, u) => {
    if (seedOf[u].last && firstSet.has(u)) placementConflicts.push(u);
    else if (lastSet.has(u) && firstSet.has(u)) placementConflicts.push(u);
    unit.placement = firstSet.has(u) ? 0 : lastSet.has(u) ? 2 : 1;
  });
  if (placementConflicts.length > 0) {
    const groupIds = new Set();
    const mods = [];
    for (const u of placementConflicts) {
      for (const group of units[u].placementGroups) groupIds.add(String(group.id));
      for (const below of closure([u], succs)) {
        for (const group of units[below].placementGroups) if (group.placement === "first") groupIds.add(String(group.id));
      }
      mods.push(...units[u].members);
    }
    mods.sort((a, b) => index.get(a) - index.get(b));
    warnings.push({ code: "placementConflict", params: { groups: [...groupIds], mods: mods.slice(0, SMART_SORT_LIMITS.maxCycleMods) } });
  }
  // A conflict winner against a placement gives way to the placement.
  units.edges = units.edges.filter((edge) => {
    if (units[edge.from].placement <= units[edge.to].placement) return true;
    if (!edge.members.every((c) => c.reason === "conflictWinner")) return true;
    for (const c of edge.members) c.state = "placement";
    return false;
  });

  // ── Order: the best of a few candidate orders ──
  const keyOf = units.map((unit) => {
    let tier = Infinity;
    let first = Infinity;
    for (const id of unit.members) {
      first = Math.min(first, index.get(id));
      tier = Math.min(tier, classification.get(id)?.tier ?? 2);
    }
    return { placement: unit.placement, tier: tiered ? tier : 0, first };
  });
  const priority = tiered || keyOf.some((k) => k.placement !== 1);
  const firstKeys = keyOf.map((k) => [k.first]);
  let candidates = [
    // The game's way: each unit right after what it must follow, pulled forward.
    pullUpOrder(count, units.edges, firstKeys),
    // The other way: a unit that must follow waits, the others go ahead.
    kahnOrder(count, units.edges, keyOf, false),
    // From the bottom: a unit that must come first is pushed up.
    kahnOrder(count, units.edges, keyOf, true),
  ];
  if (priority) candidates = candidates.map((base) => priorityOrder(count, units.edges, base, keyOf));

  const incident = new Set();
  for (const c of constraints) {
    incident.add(c.before);
    incident.add(c.after);
  }
  const isConstrained = (id) =>
    incident.has(id) ||
    units[unitOf.get(id)].group !== null ||
    units[unitOf.get(id)].placement !== 1 ||
    (tiered && classification.has(id));
  const weight = (id) => (isConstrained(id) ? 1 : n + 1);
  let result = null;
  let fewest = Infinity;
  for (const unitOrder of candidates) {
    const order = unitOrder.flatMap((u) => units[u].members);
    const movedCount = order.length - keptInPlace(order, index, weight).size;
    if (movedCount < fewest) {
      fewest = movedCount;
      result = order;
    }
  }
  for (const unit of units) {
    unit.apartIn = (positions) => {
      const at = unit.members.map((id) => positions.get(id)).sort((a, b) => a - b);
      return at[at.length - 1] - at[0] !== at.length - 1;
    };
  }
  return {
    result,
    constraints,
    cycles,
    warnings,
    units,
    unitOfMod: unitOf,
    isConstrained,
    needsCheck: priority || blocks.some((b) => b.split) || cycles.length > 0 || fewest > 0,
  };
}

/**
 * Kahn's algorithm over units: forward picks the ready unit with the
 * smallest key (placement, tier, current position); backward builds from the
 * end, picking the unit with the largest key whose successors are all placed.
 */
function kahnOrder(count, edges, keyOf, backward) {
  const out = Array.from({ length: count }, () => []);
  const remaining = new Int32Array(count);
  for (const edge of edges) {
    if (backward) {
      out[edge.to].push(edge.from);
      remaining[edge.from]++;
    } else {
      out[edge.from].push(edge.to);
      remaining[edge.to]++;
    }
  }
  const key = (u) => [keyOf[u].placement, keyOf[u].tier, keyOf[u].first];
  const better = backward ? (a, b) => compareKeys(key(a), key(b)) > 0 : (a, b) => compareKeys(key(a), key(b)) < 0;
  const heap = createHeap(better);
  for (let u = 0; u < count; u++) if (remaining[u] === 0) heap.push(u);
  const order = [];
  while (heap.size() > 0) {
    const u = heap.pop();
    order.push(u);
    for (const next of out[u]) if (--remaining[next] === 0) heap.push(next);
  }
  if (order.length !== count) return Array.from({ length: count }, (_, i) => i);
  return backward ? order.reverse() : order;
}

function createHeap(before) {
  const items = [];
  return {
    size: () => items.length,
    push(value) {
      items.push(value);
      for (let i = items.length - 1; i > 0; ) {
        const parent = (i - 1) >> 1;
        if (!before(items[i], items[parent])) break;
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < items.length && before(items[l], items[m])) m = l;
          if (r < items.length && before(items[r], items[m])) m = r;
          if (m === i) break;
          [items[i], items[m]] = [items[m], items[i]];
          i = m;
        }
      }
      return top;
    },
  };
}

function moveConfidence(reasons) {
  let best = "low";
  for (const r of reasons) {
    if (HIGH_REASONS.has(r.code)) return "high";
    if (MEDIUM_REASONS.has(r.code)) best = "medium";
    if (r.code === "patch" && r.params?.confidence && r.params.confidence !== "low") best = "medium";
  }
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The game's way of ordering: nodes in key order, each one placed right after
 * its not yet placed predecessors (themselves placed the same way, in key
 * order). `edges` is an acyclic list of { from, to }; `keys[node]` an array
 * compared element by element (or a single-element array).
 */
function pullUpOrder(count, edges, keys) {
  const preds = Array.from({ length: count }, () => []);
  for (const edge of edges) preds[edge.to].push(edge.from);
  const byKey = (a, b) => compareKeys(keys[a], keys[b]) || a - b;
  for (const list of preds) list.sort(byKey);
  const roots = Array.from({ length: count }, (_, i) => i).sort(byKey);
  const placed = new Uint8Array(count);
  const onPath = new Uint8Array(count);
  const out = [];
  for (const root of roots) {
    if (placed[root]) continue;
    const stack = [[root, 0]];
    onPath[root] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [node] = frame;
      const list = preds[node];
      let next = -1;
      while (frame[1] < list.length) {
        const candidate = list[frame[1]++];
        if (!placed[candidate] && !onPath[candidate]) {
          next = candidate;
          break;
        }
      }
      if (next !== -1) {
        onPath[next] = 1;
        stack.push([next, 0]);
        continue;
      }
      stack.pop();
      onPath[node] = 0;
      placed[node] = 1;
      out.push(node);
    }
  }
  return out;
}

/**
 * Placement and tier on top of the game's order `base` (a topological order
 * of `edges`): Kahn's algorithm picking the ready unit whose most urgent
 * successor (itself included) has the smallest (placement, tier, position in
 * `base`). A unit is so pulled forward exactly when something placed early
 * needs it, and a unit placed "last" or of a late tier still goes right
 * before the first unit that needs it. Run on its own output it picks the
 * same unit at every step (the key's position part is then the output's own
 * order), which is what makes a plan idempotent.
 */
function priorityOrder(count, edges, base, keyOf) {
  const position = new Array(count);
  base.forEach((u, i) => {
    position[u] = i;
  });
  const own = (u) => [keyOf[u].placement, keyOf[u].tier, position[u]];
  const succ = Array.from({ length: count }, () => []);
  const inDegree = new Array(count).fill(0);
  for (const edge of edges) {
    succ[edge.from].push(edge.to);
    inDegree[edge.to]++;
  }
  const urgent = new Array(count);
  for (let i = base.length - 1; i >= 0; i--) {
    const u = base[i];
    let best = own(u);
    for (const s of succ[u]) if (compareKeys(urgent[s], best) < 0) best = urgent[s];
    urgent[u] = best;
  }
  const less = (a, b) => compareKeys(urgent[a], urgent[b]) < 0 || (compareKeys(urgent[a], urgent[b]) === 0 && compareKeys(own(a), own(b)) < 0);
  const heap = [];
  const push = (u) => {
    heap.push(u);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (let u = 0; u < count; u++) if (inDegree[u] === 0) push(u);
  const out = [];
  while (heap.length > 0) {
    const u = pop();
    out.push(u);
    for (const s of succ[u]) if (--inDegree[s] === 0) push(s);
  }
  return out.length === count ? out : base;
}

/**
 * The mods that kept their relative order: the heaviest subsequence of
 * `result` that is increasing in original index (Fenwick tree, n log n).
 * `weightOf(id)` prefers keeping mods no constraint asked to move.
 */
function keptInPlace(result, index, weightOf) {
  const n = result.length;
  const tree = new Array(n + 1).fill(null); // best { weight, at } over original index prefix
  const best = new Array(n);
  const prev = new Array(n).fill(-1);
  const better = (a, b) => (!b || a.weight > b.weight ? a : b);
  const query = (i) => {
    let res = null;
    for (let k = i; k > 0; k -= k & -k) res = better(tree[k] || { weight: -1, at: -1 }, res);
    return res && res.weight >= 0 ? res : null;
  };
  const update = (i, value) => {
    for (let k = i; k <= n; k += k & -k) tree[k] = better(value, tree[k]);
  };
  let top = null;
  for (let j = 0; j < n; j++) {
    const original = index.get(result[j]);
    const before = query(original); // indices < original (1-based prefix of original)
    const weight = (before ? before.weight : 0) + weightOf(result[j]);
    best[j] = weight;
    prev[j] = before ? before.at : -1;
    const entry = { weight, at: j };
    update(original + 1, entry);
    if (!top || weight > top.weight) top = entry;
  }
  const keep = new Set();
  for (let j = top ? top.at : -1; j !== -1; j = prev[j]) keep.add(result[j]);
  return keep;
}
