import { describe, expect, it } from "vitest";
import { buildLoadOrderConstraints, planLoadOrder } from "../utils/modSmartSort.js";

// The client's group-aware Auto-sort (client/src/lib/loadOrderAutoSort.ts on
// ux/mods-qol) moves to the server: POST /mods/load-order/plan is the one
// sort. Its scenarios and property tests are ported here against the server
// planner, with its vocabulary mapped to the server's:
//   requires {modId} / requiredBy {modId}  -> { code: "require", params: { relation: "after" | "before", other } }
//   groupOrder {groupId}                   -> { code: "groupOrder", params: { group, ... } }
//   together {groupId}                     -> { code: "keepTogether", params: { group, groupName } }
//   placement {groupId, placement}         -> { code: "groupPlacement", params: { group, groupName, placement } }
//   winner {over} / keepsWinner {winner}   -> { code: "conflictWinner", params: { relation, other } }
//   splitGroups                            -> warnings keepTogetherBroken { group, groupName, mods }
//   groupOrderConflicts                    -> unsatisfied { reason: "groupOrder", why, by }
//   placementConflicts                     -> warnings placementConflict { groups, mods }
//   winnersChanged {previousWinner, newWinner, cause} -> winnersChanged { previousWinner, newWinner, why, by }
//   missing {modId, requires}              -> unsatisfied { before: requires, after: modId, why: "missingMod" }
// Positions are 0-based on the server (1-based in the client's moves).
// Requirements match exactly, like the game (the client also matched forks
// and other letter case; the game does not, so neither does the server).

function autoSort({ order, requires = {}, groups = [], conflictPairs = [], mode }) {
  const map = requires instanceof Map ? requires : new Map(Object.entries(requires));
  const mods = [...new Set(order)].map((id) => ({ id, require: [...(map.get(id) || [])] }));
  for (const [id, list] of map) if (!mods.some((m) => m.id === id)) mods.push({ id, require: [...list] });
  const groupList = groups.map((g) => ({ name: g.id, ...g }));
  const built = buildLoadOrderConstraints({ order, mods, groups: groupList, conflictPairs });
  return planLoadOrder({ order, ...built, groups: groupList, mode });
}

const ids = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const SEEDS = Number(process.env.AUTOSORT_SEEDS ?? 250);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];
function shuffle(random, list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const req = (relation, other) => ({ code: "require", params: { relation, other } });
const missingOf = (result) => result.unsatisfied.filter((u) => u.why === "missingMod");

describe("dependencies", () => {
  it("leaves an order without rules untouched", () => {
    const result = autoSort({ order: ["B", "A", "C"] });
    expect(result.order).toEqual(["B", "A", "C"]);
    expect(result.moves).toEqual([]);
    expect(result.stats.constraints).toBe(0);
  });

  it("moves a library appended at the end up to its first dependent: one move, not one per dependent", () => {
    const result = autoSort({ order: ["M1", "a", "b", "c", "d", "M5", "Lib"], requires: { M1: ["Lib"], M5: ["Lib"] } });
    expect(result.order).toEqual(["Lib", "M1", "a", "b", "c", "d", "M5"]);
    expect(result.moves).toEqual([
      { modId: "Lib", from: 6, to: 0, reasons: [req("before", "M1"), req("before", "M5")], confidence: "high" },
    ]);
  });

  it("moves a dependent placed above its library with a single move", () => {
    const result = autoSort({ order: ["Overhaul", "A", "B", "BaseLibrary", "C"], requires: { Overhaul: ["BaseLibrary"] } });
    expect(result.moves).toHaveLength(1);
    expect(result.order.indexOf("BaseLibrary")).toBeLessThan(result.order.indexOf("Overhaul"));
    expect(result.order.filter((id) => ["A", "B", "C"].includes(id))).toEqual(["A", "B", "C"]);
  });

  it("explains a move by the requirement it now loads after", () => {
    const result = autoSort({ order: ["Patch", "Core"], requires: { Patch: ["Core"] } });
    expect(result.order).toEqual(["Core", "Patch"]);
    expect(result.moves).toHaveLength(1);
    const [move] = result.moves;
    expect(move.reasons).toContainEqual(move.modId === "Core" ? req("before", "Patch") : req("after", "Core"));
  });

  it("reports a dependency cycle and still enforces everything around it", () => {
    const result = autoSort({ order: ["Downstream", "A", "B", "Lib"], requires: { A: ["B"], B: ["A"], Downstream: ["A"] } });
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toMatchObject({ mods: ["A", "B"], gameCrash: true });
    expect(result.order.indexOf("A")).toBeLessThan(result.order.indexOf("Downstream"));
  });

  it("reports requirements that are not enabled, without failing", () => {
    const result = autoSort({ order: ["A"], requires: { A: ["Missing", "Missing"] } });
    expect(missingOf(result)).toEqual([{ before: "Missing", after: "A", reason: "require", why: "missingMod" }]);
    expect(result.order).toEqual(["A"]);
  });

  it("matches a requirement exactly, as the game does (no fork or case guess)", () => {
    const result = autoSort({ order: ["User", "tchernolib_B42"], requires: { User: ["TchernoLib"] } });
    expect(result.order).toEqual(["User", "tchernolib_B42"]);
    expect(missingOf(result)).toEqual([{ before: "TchernoLib", after: "User", reason: "require", why: "missingMod" }]);
  });

  it("counts a repeated mod ID once", () => {
    expect(autoSort({ order: ["A", "B", "A"], requires: { A: ["B"] } }).order).toEqual(["B", "A"]);
  });
});

describe("groups", () => {
  const ki5 = { id: "ki5", modIds: ["KI5Lib", "KI5Core", "KI5AddOn", "KI5Fix"] };

  it("keeps every group in its own order, moving as few mods as possible", () => {
    const result = autoSort({ order: ["KI5Core", "X", "KI5Lib", "Y", "KI5AddOn", "KI5Fix"], groups: [ki5] });
    expect(result.order.filter((id) => id.startsWith("KI5"))).toEqual(["KI5Lib", "KI5Core", "KI5AddOn", "KI5Fix"]);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0].reasons.map((r) => r.code)).toContain("groupOrder");
  });

  it("a keep-together group becomes one block at its first member, the mods in between follow it", () => {
    const result = autoSort({
      order: ["A", "KI5Lib", "B", "KI5Core", "C", "KI5AddOn", "D", "KI5Fix", "E"],
      groups: [{ ...ki5, keepTogether: true }],
    });
    expect(result.order).toEqual(["A", "KI5Lib", "KI5Core", "KI5AddOn", "KI5Fix", "B", "C", "D", "E"]);
    expect(result.moves.map((move) => move.modId)).toEqual(["KI5Core", "KI5AddOn", "KI5Fix"]);
    for (const move of result.moves) expect(move.reasons).toContainEqual({ code: "keepTogether", params: { group: "ki5", groupName: "ki5" } });
  });

  it("a block is one node: a mod that needs one member loads after the whole block", () => {
    const result = autoSort({
      order: ["User", "A", "KI5Lib", "KI5Core"],
      requires: { User: ["KI5Lib"] },
      groups: [{ id: "g", modIds: ["KI5Lib", "KI5Core"], keepTogether: true }],
    });
    // One move (User) beats moving the two-mod block.
    expect(result.order).toEqual(["A", "KI5Lib", "KI5Core", "User"]);
    expect(result.moves.map((move) => move.modId)).toEqual(["User"]);
  });

  it("reports a keep-together group that a dependency splits, and keeps the dependency", () => {
    const result = autoSort({
      order: ["G1", "Mid", "G2"],
      requires: { Mid: ["G1"], G2: ["Mid"] },
      groups: [{ id: "g", modIds: ["G1", "G2"], keepTogether: true }],
    });
    expect(result.warnings).toEqual([{ code: "keepTogetherBroken", params: { group: "g", groupName: "g", mods: ["Mid"] } }]);
    expect(result.order).toEqual(["G1", "Mid", "G2"]);
  });

  it("a dependency wins over a group order that contradicts it, and says so", () => {
    const result = autoSort({ order: ["AddOn", "Lib"], requires: { AddOn: ["Lib"] }, groups: [{ id: "g", modIds: ["AddOn", "Lib"] }] });
    expect(result.order).toEqual(["Lib", "AddOn"]);
    expect(result.unsatisfied).toEqual([
      { before: "AddOn", after: "Lib", reason: "groupOrder", why: "conflictsWithHarder", by: "require", group: "g" },
    ]);
  });

  it("two groups that contradict each other: the first listed wins, the other is reported", () => {
    const result = autoSort({ order: ["B", "A"], groups: [{ id: "one", modIds: ["A", "B"] }, { id: "two", modIds: ["B", "A"] }] });
    expect(result.order).toEqual(["A", "B"]);
    expect(result.unsatisfied).toEqual([
      { before: "B", after: "A", reason: "groupOrder", why: "conflictsWithHarder", by: "groupOrder", group: "two" },
    ]);
  });

  it("ignores group members that are not in the load order", () => {
    expect(autoSort({ order: ["KI5Core", "KI5Lib"], groups: [ki5] }).order).toEqual(["KI5Lib", "KI5Core"]);
  });
});

describe("placement", () => {
  it('a "first" group loads before everything else, with what it requires', () => {
    const result = autoSort({
      order: ["A", "B", "Needed", "Fw1", "C", "Fw2"],
      requires: { Fw2: ["Needed"] },
      groups: [{ id: "fw", modIds: ["Fw1", "Fw2"], placement: "first" }],
    });
    expect(result.order.slice(0, 3).sort()).toEqual(["Fw1", "Fw2", "Needed"]);
    expect(result.order.indexOf("Needed")).toBeLessThan(result.order.indexOf("Fw2"));
    expect(result.order.slice(3)).toEqual(["A", "B", "C"]);
    const fw1 = result.moves.find((move) => move.modId === "Fw1");
    expect(fw1?.reasons).toContainEqual({ code: "groupPlacement", params: { group: "fw", groupName: "fw", placement: "first" } });
  });

  it('a "last" group loads after everything else, with what requires it', () => {
    const result = autoSort({
      order: ["Fix1", "A", "NeedsFix", "B", "Fix2", "C"],
      requires: { NeedsFix: ["Fix1"] },
      groups: [{ id: "fixes", modIds: ["Fix1", "Fix2"], placement: "last" }],
    });
    expect(result.order.slice(0, 3)).toEqual(["A", "B", "C"]);
    expect(result.order.slice(3).sort()).toEqual(["Fix1", "Fix2", "NeedsFix"]);
    expect(result.order.indexOf("Fix1")).toBeLessThan(result.order.indexOf("NeedsFix"));
  });

  it('a "last" mod that a "first" mod requires loads first, and the conflict is reported', () => {
    const result = autoSort({
      order: ["A", "Early", "Late"],
      requires: { Early: ["Late"] },
      groups: [
        { id: "first", modIds: ["Early"], placement: "first" },
        { id: "last", modIds: ["Late"], placement: "last" },
      ],
    });
    expect(result.order).toEqual(["Late", "Early", "A"]);
    expect(result.warnings).toEqual([{ code: "placementConflict", params: { groups: ["last", "first"], mods: ["Late"] } }]);
  });
});

describe("conflict winners", () => {
  it("keeps the current winner of a file conflict while moving a mod for a dependency", () => {
    const result = autoSort({ order: ["Rival", "Patch", "X", "Lib"], requires: { Patch: ["Lib"] }, conflictPairs: [["Rival", "Patch"]] });
    expect(result.order.indexOf("Rival")).toBeLessThan(result.order.indexOf("Patch"));
    expect(result.order.indexOf("Lib")).toBeLessThan(result.order.indexOf("Patch"));
    expect(result.winnersChanged).toEqual([]);
  });

  it("keeps a winner by moving its loser along", () => {
    const result = autoSort({ order: ["User", "Other", "Lib"], requires: { User: ["Lib"] }, conflictPairs: [["Other", "Lib"]] });
    expect(result.order).toEqual(["Other", "Lib", "User"]);
    expect(result.winnersChanged).toEqual([]);
  });

  it("reports a winner that a dependency forces to change", () => {
    const result = autoSort({ order: ["Base", "Addon"], requires: { Base: ["Addon"] }, conflictPairs: [["Base", "Addon"]] });
    expect(result.order).toEqual(["Addon", "Base"]);
    expect(result.winnersChanged).toEqual([{ previousWinner: "Addon", newWinner: "Base", why: "conflictsWithHarder", by: "require" }]);
  });

  it('reports a winner that a "last" placement changes', () => {
    const result = autoSort({
      order: ["Fix", "Content"],
      groups: [{ id: "fixes", modIds: ["Fix"], placement: "last" }],
      conflictPairs: [["Fix", "Content"]],
    });
    expect(result.order).toEqual(["Content", "Fix"]);
    expect(result.winnersChanged).toEqual([{ previousWinner: "Content", newWinner: "Fix", why: "conflictsWithHarder", by: "groupPlacement" }]);
  });
});

// ── Property tests ───────────────────────────────────────────────────────────

/**
 * A scenario every rule of which can be met: a hidden target order T, rules
 * read off T (dependencies point forward in T, group orders are T's order,
 * keep-together groups are runs of T, "first" groups sit in T's front third
 * and "last" groups in its back third), and a shuffled current order.
 */
function satisfiableScenario(seed) {
  const random = rng(seed);
  const count = 8 + Math.floor(random() * 40);
  const target = ids("m", count);
  const front = Math.floor(count / 3);
  const back = count - Math.floor(count / 3);
  const deps = new Map();
  const edgeCount = Math.floor(random() * count * 1.2);
  for (let e = 0; e < edgeCount; e++) {
    const i = Math.floor(random() * count);
    const j = Math.floor(random() * count);
    if (i === j) continue;
    const [a, b] = i < j ? [i, j] : [j, i];
    deps.set(target[b], [...(deps.get(target[b]) ?? []), target[a]]);
  }
  const groups = [];
  const used = new Set();
  const groupCount = Math.floor(random() * 5);
  for (let g = 0; g < groupCount; g++) {
    if (random() < 0.4) {
      const third = Math.floor(random() * 3);
      const [lo, hi] = third === 0 ? [0, front] : third === 1 ? [front, back] : [back, count];
      if (hi - lo < 2) continue;
      const start = lo + Math.floor(random() * (hi - lo - 1));
      const length = 2 + Math.floor(random() * Math.min(4, hi - start - 1));
      const members = target.slice(start, Math.min(hi, start + length));
      if (members.some((m) => used.has(m))) continue;
      members.forEach((m) => used.add(m));
      groups.push({ id: `kt${g}`, modIds: members, keepTogether: true });
    } else {
      const members = target.filter(() => random() < 0.15);
      if (members.length < 2) continue;
      groups.push({ id: `g${g}`, modIds: members });
    }
  }
  if (random() < 0.6) {
    const members = target.slice(0, front).filter((m) => !used.has(m) && random() < 0.4);
    if (members.length > 0) groups.push({ id: "first", modIds: members, placement: "first" });
  }
  if (random() < 0.6) {
    const members = target.slice(back).filter((m) => !used.has(m) && random() < 0.4);
    if (members.length > 0) groups.push({ id: "last", modIds: members, placement: "last" });
  }
  return { order: shuffle(random, target), requires: deps, groups };
}

function satisfiedEverywhere(input, order, seed) {
  const at = new Map(order.map((id, i) => [id, i]));
  for (const [modId, list] of input.requires) {
    for (const dep of list) expect(at.get(dep), `seed ${seed}: ${dep} before ${modId}`).toBeLessThan(at.get(modId));
  }
  for (const group of input.groups) {
    const positions = group.modIds.map((id) => at.get(id)).filter((p) => p !== undefined);
    expect(positions, `seed ${seed}: group ${group.id} order`).toEqual([...positions].sort((a, b) => a - b));
    if (group.keepTogether && positions.length > 1) {
      expect(Math.max(...positions) - Math.min(...positions), `seed ${seed}: group ${group.id} together`).toBe(positions.length - 1);
    }
  }
}

function closure(input, seeds, direction) {
  const edges = [];
  for (const [modId, list] of input.requires) for (const dep of list) edges.push([dep, modId]);
  for (const group of input.groups) {
    for (let i = 0; i + 1 < group.modIds.length; i++) edges.push([group.modIds[i], group.modIds[i + 1]]);
  }
  const blockOf = new Map();
  for (const group of input.groups) {
    if (!group.keepTogether) continue;
    for (const id of group.modIds) blockOf.set(id, [...group.modIds]);
  }
  const found = new Set();
  const stack = [...seeds];
  const visit = (id) => {
    for (const member of blockOf.get(id) ?? [id]) {
      if (found.has(member)) continue;
      found.add(member);
      stack.push(member);
    }
  };
  seeds.forEach(visit);
  while (stack.length > 0) {
    const id = stack.pop();
    for (const [from, to] of edges) {
      if (direction === "up" && to === id) visit(from);
      if (direction === "down" && from === id) visit(to);
    }
  }
  return found;
}

describe("properties", () => {
  it("meets every rule when the rules can all be met, and reports nothing", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const input = satisfiableScenario(seed);
      const result = autoSort(input);
      expect([...result.order].sort(), `seed ${seed}: same mods`).toEqual([...input.order].sort());
      satisfiedEverywhere(input, result.order, seed);
      expect(result.cycles, `seed ${seed}`).toEqual([]);
      expect(result.warnings, `seed ${seed}`).toEqual([]);
      expect(result.unsatisfied, `seed ${seed}`).toEqual([]);

      const at = new Map(result.order.map((id, i) => [id, i]));
      const first = input.groups.find((g) => g.placement === "first");
      const last = input.groups.find((g) => g.placement === "last");
      const frontSet = first ? closure(input, [...first.modIds], "up") : new Set();
      const rear = last ? closure(input, [...last.modIds], "down") : new Set();
      for (const id of result.order) {
        for (const f of frontSet) if (!frontSet.has(id)) expect(at.get(f), `seed ${seed}: ${f} first, before ${id}`).toBeLessThan(at.get(id));
        for (const l of rear) if (!rear.has(id)) expect(at.get(l), `seed ${seed}: ${l} last, after ${id}`).toBeGreaterThan(at.get(id));
      }
    }
  });

  it("is idempotent: sorting the result again moves nothing", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const input = satisfiableScenario(seed);
      const random = rng(seed * 7);
      const pairs = Array.from({ length: Math.floor(random() * 10) }, () => [pick(random, input.order), pick(random, input.order)]);
      for (const mode of ["minimal", "tiered"]) {
        const firstRun = autoSort({ ...input, conflictPairs: pairs, mode });
        const again = autoSort({ ...input, order: firstRun.order, conflictPairs: pairs, mode });
        expect(again.order, `seed ${seed} ${mode}`).toEqual(firstRun.order);
        expect(again.moves, `seed ${seed} ${mode}`).toEqual([]);
      }
    }
  });

  it("never moves or reorders a mod no rule mentions", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const input = satisfiableScenario(seed);
      const random = rng(seed * 13);
      const pairs = Array.from({ length: Math.floor(random() * 6) }, () => [pick(random, input.order), pick(random, input.order)]);
      const mentioned = new Set();
      for (const [modId, list] of input.requires) {
        if (list.length > 0) mentioned.add(modId);
        list.forEach((id) => mentioned.add(id));
      }
      for (const group of input.groups) group.modIds.forEach((id) => mentioned.add(id));
      for (const [a, b] of pairs) {
        mentioned.add(a);
        mentioned.add(b);
      }
      const result = autoSort({ ...input, conflictPairs: pairs });
      expect(result.order.filter((id) => !mentioned.has(id)), `seed ${seed}`).toEqual(input.order.filter((id) => !mentioned.has(id)));
      for (const move of result.moves) expect(mentioned.has(move.modId), `seed ${seed}: ${move.modId} moved`).toBe(true);
    }
  });

  it("keeps every conflict winner it does not report as changed", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const input = satisfiableScenario(seed);
      const random = rng(seed * 31);
      const pairs = Array.from({ length: 1 + Math.floor(random() * 12) }, () => [pick(random, input.order), pick(random, input.order)]);
      const result = autoSort({ ...input, conflictPairs: pairs });
      const before = new Map(input.order.map((id, i) => [id, i]));
      const after = new Map(result.order.map((id, i) => [id, i]));
      const changed = new Set(result.winnersChanged.map((w) => `${w.newWinner}>${w.previousWinner}`));
      for (const [a, b] of pairs) {
        if (a === b) continue;
        const [loser, winner] = before.get(a) < before.get(b) ? [a, b] : [b, a];
        const kept = after.get(loser) < after.get(winner);
        expect(kept || changed.has(`${loser}>${winner}`), `seed ${seed}: ${winner} over ${loser}`).toBe(true);
      }
      for (const w of result.winnersChanged) expect(after.get(w.newWinner), `seed ${seed}`).toBeGreaterThan(after.get(w.previousWinner));
    }
  });

  it("with contradictory rules: never throws, keeps every dependency outside a reported loop, and stays idempotent", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed * 101);
      const count = 4 + Math.floor(random() * 30);
      const order = ids("x", count);
      const deps = new Map();
      for (let e = 0; e < count; e++) {
        const a = pick(random, order);
        const b = pick(random, order);
        if (a === b) continue;
        deps.set(b, [...(deps.get(b) ?? []), a]);
      }
      const groups = Array.from({ length: Math.floor(random() * 4) }, (_, g) => ({
        id: `g${g}`,
        modIds: shuffle(random, order).slice(0, 2 + Math.floor(random() * 5)),
        keepTogether: random() < 0.4,
        placement: random() < 0.3 ? (random() < 0.5 ? "first" : "last") : null,
      }));
      const pairs = Array.from({ length: Math.floor(random() * 8) }, () => [pick(random, order), pick(random, order)]);
      const input = { order: shuffle(random, order), requires: deps, groups, conflictPairs: pairs };
      const result = autoSort(input);
      expect([...result.order].sort()).toEqual([...order].sort());
      const at = new Map(result.order.map((id, i) => [id, i]));
      const loops = result.cycles.filter((c) => c.gameCrash).map((c) => new Set(c.mods));
      for (const [modId, list] of deps) {
        for (const dep of list) {
          if (loops.some((loop) => loop.has(dep) && loop.has(modId))) continue;
          expect(at.get(dep), `seed ${seed}: ${dep} before ${modId}`).toBeLessThan(at.get(modId));
        }
      }
      const again = autoSort({ ...input, order: result.order });
      expect(again.order, `seed ${seed}: idempotent`).toEqual(result.order);
    }
  });

  it("sorts 600 mods with dense rules quickly", () => {
    const random = rng(600);
    const order = ids("mod", 600);
    const deps = new Map();
    for (let i = 0; i < 700; i++) {
      const a = Math.floor(random() * 600);
      const b = Math.floor(random() * 600);
      if (a === b) continue;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      deps.set(order[hi], [...(deps.get(order[hi]) ?? []), order[lo]]);
    }
    const groups = Array.from({ length: 40 }, (_, g) => ({
      id: `g${g}`,
      modIds: order.slice(g * 15, g * 15 + 6),
      keepTogether: g % 3 === 0,
      placement: g === 1 ? "first" : g === 39 ? "last" : null,
    }));
    const pairs = Array.from({ length: 400 }, () => [pick(random, order), pick(random, order)]);
    const started = performance.now();
    const result = autoSort({ order: shuffle(random, order), requires: deps, groups, conflictPairs: pairs });
    expect(result.order).toHaveLength(600);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
