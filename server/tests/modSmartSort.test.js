import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_REASONS,
  SMART_SORT_LIMITS,
  buildLoadOrderConstraints,
  planLoadOrder,
} from "../utils/modSmartSort.js";

// The load-order planner (utils/modSmartSort.js): constraints from what the
// panel knows, loops broken weakest first, the order built the way the game
// loads mods, and planning its own result again changes nothing.

function plan(order, mods, extra = {}) {
  const built = buildLoadOrderConstraints({ order, mods, ...extra });
  return planLoadOrder({
    order,
    constraints: built.constraints,
    missing: built.missing,
    implicit: built.implicit,
    ...extra,
  });
}

const mod = (id, fields = {}) => ({ id, ...fields });

// Deterministic PRNG (mulberry32) for the property tests.
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

function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A random mod list: require/loadAfter/loadBefore links (some in loops),
// rules, groups (some kept together, some placed first/last), tiers.
function randomCase(seed, size = 30) {
  const random = rng(seed);
  const ids = Array.from({ length: size }, (_, i) => `m${i}`);
  const mods = ids.map((id) => mod(id, { require: [], loadAfter: [], loadBefore: [] }));
  const pick = () => ids[Math.floor(random() * size)];
  for (let k = 0; k < size; k++) {
    const a = pick();
    const b = pick();
    if (a === b) continue;
    const roll = random();
    const target = mods.find((m) => m.id === a);
    if (roll < 0.3) target.require.push(b);
    else if (roll < 0.6) target.loadAfter.push(b);
    else target.loadBefore.push(b);
  }
  const rules = [];
  for (let k = 0; k < 3; k++) {
    const a = pick();
    const b = pick();
    if (a !== b) rules.push({ id: `r${k}`, before: a, after: b });
  }
  const groups = [];
  for (let g = 0; g < 3; g++) {
    const members = [...new Set(Array.from({ length: 2 + Math.floor(random() * 4) }, pick))];
    const placements = [null, null, "first", "last"];
    groups.push({
      id: `g${g}`,
      name: `Group ${g}`,
      modIds: members,
      keepTogether: random() < 0.5,
      placement: placements[Math.floor(random() * placements.length)],
    });
  }
  const classification = new Map(ids.map((id) => [id, { tier: Math.floor(random() * 5), kind: "content" }]));
  return { order: shuffle(ids, random), mods, rules, groups, classification };
}

describe("planLoadOrder: the game's way of ordering", () => {
  it("pulls a required mod forward to right before the first mod that needs it, like the game loads it", () => {
    const result = plan(["B", "X", "A"], [mod("B", { require: ["A"] }), mod("X"), mod("A")]);
    expect(result.order).toEqual(["A", "B", "X"]);
    expect(result.changed).toBe(true);
    expect(result.moves).toEqual([
      {
        modId: "A",
        from: 2,
        to: 0,
        reasons: [{ code: "require", params: { relation: "before", other: "B" } }],
        confidence: "high",
      },
    ]);
    expect(result.explanations.B).toEqual([{ code: "require", params: { relation: "after", other: "A" } }]);
    expect(result.satisfied).toBe(1);
    expect(result.unsatisfied).toEqual([]);
  });

  it("changes nothing on an order that already holds", () => {
    const mods = [mod("A"), mod("B", { require: ["A"] }), mod("C", { loadAfter: ["B"] })];
    const result = plan(["A", "B", "C"], mods);
    expect(result.changed).toBe(false);
    expect(result.moves).toEqual([]);
    expect(result.order).toEqual(["A", "B", "C"]);
  });

  it("never reorders mods nothing constrains among themselves", () => {
    const random = rng(7);
    for (let round = 0; round < 50; round++) {
      const { order, mods } = randomCase(1000 + round, 40);
      const result = plan(order, mods);
      const constrained = new Set();
      const built = buildLoadOrderConstraints({ order, mods });
      for (const c of built.constraints) {
        constrained.add(c.before);
        constrained.add(c.after);
      }
      const free = (list) => list.filter((id) => !constrained.has(id));
      expect(free(result.order)).toEqual(free(order));
      void random;
    }
  });

  it("is idempotent: planning its own result changes nothing (minimal and tiered, with groups and loops)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { order, mods, rules, groups, classification } = randomCase(seed, 12 + (seed % 25));
      for (const mode of ["minimal", "tiered"]) {
        const first = plan(order, mods, { rules, groups, classification, mode });
        const second = plan(first.order, mods, { rules, groups, classification, mode });
        expect(second.order, `seed ${seed} ${mode}`).toEqual(first.order);
        expect(second.changed, `seed ${seed} ${mode}`).toBe(false);
        expect(second.moves).toEqual([]);
      }
    }
  });

  it("returns a permutation of the order and keeps every constraint it did not report", () => {
    for (let seed = 400; seed < 500; seed++) {
      const { order, mods, rules, groups, classification } = randomCase(seed, 30);
      const result = plan(order, mods, { rules, groups, classification, mode: seed % 2 ? "tiered" : "minimal" });
      expect([...result.order].sort()).toEqual([...order].sort());
      const position = new Map(result.order.map((id, i) => [id, i]));
      const reported = new Set(result.unsatisfied.map((u) => `${u.before}>${u.after}`));
      const built = buildLoadOrderConstraints({ order, mods, rules, groups, classification });
      let held = 0;
      for (const c of built.constraints) {
        if (position.get(c.before) < position.get(c.after)) held++;
        else expect(reported.has(`${c.before}>${c.after}`), `seed ${seed}: ${c.before}>${c.after} ${c.reason}`).toBe(true);
      }
      expect(result.satisfied).toBe(held);
      for (const u of result.unsatisfied) expect(["cycle", "conflictsWithHarder", "missingMod"]).toContain(u.why);
    }
  });
});

describe("planLoadOrder: contradictions", () => {
  it("drops the loadModAfter= the current order already breaks, and reports the loop", () => {
    const mods = [mod("A", { loadAfter: ["C"] }), mod("B", { loadAfter: ["A"] }), mod("C", { loadAfter: ["B"] })];
    const result = plan(["A", "B", "C"], mods);
    expect(result.order).toEqual(["A", "B", "C"]);
    expect(result.changed).toBe(false);
    expect(result.cycles).toEqual([{ mods: ["A", "B", "C"], droppedEdge: { before: "C", after: "A", reason: "loadAfter" } }]);
    expect(result.unsatisfied).toEqual([{ before: "C", after: "A", reason: "loadAfter", why: "cycle" }]);
  });

  it("drops require= only when the loop is all require=, and says the game crashes on it", () => {
    const result = plan(["A", "B"], [mod("A", { require: ["B"] }), mod("B", { require: ["A"] })]);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toMatchObject({ mods: ["A", "B"], gameCrash: true });
    expect(result.cycles[0].droppedEdge.reason).toBe("require");
  });

  it("keeps require= over a weaker constraint in the same loop", () => {
    // B require=s A (A first), but A says loadModAfter=B.
    const result = plan(["B", "A"], [mod("A", { loadAfter: ["B"] }), mod("B", { require: ["A"] })]);
    expect(result.order).toEqual(["A", "B"]);
    expect(result.unsatisfied).toEqual([{ before: "B", after: "A", reason: "loadAfter", why: "conflictsWithHarder", by: "require" }]);
  });

  it("a rule beats a declared loadModAfter= in the other direction", () => {
    const mods = [mod("A", { loadAfter: ["B"] }), mod("B")];
    const result = plan(["B", "A"], mods, { rules: [{ id: "r1", before: "A", after: "B" }] });
    expect(result.order).toEqual(["A", "B"]);
    expect(result.moves).toHaveLength(1);
    expect(result.explanations.A).toEqual([{ code: "rule", params: { relation: "before", other: "B", ruleId: "r1" } }]);
    expect(result.unsatisfied).toEqual([{ before: "B", after: "A", reason: "loadAfter", why: "conflictsWithHarder", by: "rule" }]);
  });

  it("finishes on loops everywhere (every pair both ways) and still returns every mod", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `x${i}`);
    const mods = ids.map((id) => mod(id, { loadAfter: ids.filter((other) => other !== id) }));
    const started = performance.now();
    const result = plan(ids, mods);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.order).toEqual(ids);
    expect(result.changed).toBe(false);
  });
});

describe("planLoadOrder: groups", () => {
  const four = [mod("M1"), mod("X"), mod("M2"), mod("Y")];

  it("gathers a group kept together at its first member, the others right after it", () => {
    const groups = [{ id: "g", name: "KI5", modIds: ["M1", "M2"], keepTogether: true }];
    const result = plan(["M1", "X", "M2", "Y"], four, { groups });
    expect(result.order).toEqual(["M1", "M2", "X", "Y"]);
    expect(result.moves.map((m) => m.modId)).toEqual(["M2"]);
    expect(result.moves[0].reasons).toContainEqual({ code: "keepTogether", params: { group: "g", groupName: "KI5" } });
    expect(result.explanations.M1).toContainEqual({ code: "keepTogether", params: { group: "g", groupName: "KI5" } });
  });

  it("keeps a group's order (the order save-order enforces), and ignores groups when asked", () => {
    const groups = [{ id: "g", name: "G", modIds: ["Y", "M1"] }];
    expect(plan(["M1", "X", "Y"], [mod("M1"), mod("X"), mod("Y")], { groups }).order).toEqual(["Y", "M1", "X"]);
    expect(plan(["M1", "X", "Y"], [mod("M1"), mod("X"), mod("Y")], { groups, useGroups: false }).changed).toBe(false);
  });

  it("splits a group kept together when require= puts another mod between its members", () => {
    // X require=s M1, M2 require=s X: M1 < X < M2.
    const mods = [mod("M1"), mod("M2", { require: ["X"] }), mod("X", { require: ["M1"] })];
    const groups = [{ id: "g", name: "G", modIds: ["M1", "M2"], keepTogether: true }];
    const result = plan(["M1", "M2", "X"], mods, { groups });
    expect(result.order).toEqual(["M1", "X", "M2"]);
    expect(result.warnings).toContainEqual({ code: "keepTogetherBroken", params: { group: "g", groupName: "G", mods: ["X"] } });
    expect(result.unsatisfied).toEqual([]);
  });

  it("keeps the group together over a loadModAfter= that would split it", () => {
    const mods = [mod("M1"), mod("M2", { loadAfter: ["X"] }), mod("X", { loadAfter: ["M1"] })];
    const groups = [{ id: "g", name: "G", modIds: ["M1", "M2"], keepTogether: true }];
    const result = plan(["M1", "M2", "X"], mods, { groups });
    expect(result.order.slice(0, 2)).toEqual(["M1", "M2"]);
    expect(result.warnings).toEqual([]);
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it("reports a mod in two groups kept together; the first group wins", () => {
    const groups = [
      { id: "a", name: "A", modIds: ["M1", "M2"], keepTogether: true },
      { id: "b", name: "B", modIds: ["M2", "Y"], keepTogether: true },
    ];
    const result = plan(["M1", "X", "M2", "Y"], four, { groups });
    expect(result.warnings).toContainEqual({ code: "inTwoKeepTogetherGroups", params: { modId: "M2", group: "a", otherGroup: "b" } });
    expect(result.order.indexOf("M2")).toBe(result.order.indexOf("M1") + 1);
  });

  it("places a group first or last as far as its constraints allow", () => {
    const mods = [mod("A"), mod("B"), mod("C"), mod("D", { require: ["C"] })];
    const first = plan(["A", "B", "C", "D"], mods, { groups: [{ id: "f", name: "F", modIds: ["D"], placement: "first" }] });
    expect(first.order).toEqual(["C", "D", "A", "B"]);
    const last = plan(["A", "B", "C", "D"], mods, { groups: [{ id: "l", name: "L", modIds: ["A"], placement: "last" }] });
    expect(last.order).toEqual(["B", "C", "D", "A"]);
    expect(last.moves[0].reasons).toContainEqual({ code: "groupPlacement", params: { group: "l", groupName: "L", placement: "last" } });
  });
});

describe("planLoadOrder: tiers", () => {
  it("in tiered mode puts libraries first and translations last, and leaves it alone in minimal mode", () => {
    const classification = new Map([
      ["T", { tier: 4, kind: "translation" }],
      ["C", { tier: 1, kind: "content" }],
      ["L", { tier: 0, kind: "library" }],
    ]);
    const mods = [mod("T"), mod("C"), mod("L")];
    const tiered = plan(["T", "C", "L"], mods, { mode: "tiered", classification });
    expect(tiered.order).toEqual(["L", "C", "T"]);
    expect(tiered.explanations.T).toContainEqual({ code: "tier", params: { tier: 4, kind: "translation" } });
    expect(tiered.stats.soft).toBe(3);
    expect(plan(["T", "C", "L"], mods, { classification }).changed).toBe(false);
  });

  it("pulls a later-tier dependency forward instead of breaking require=", () => {
    const classification = new Map([
      ["L", { tier: 0, kind: "library" }],
      ["P", { tier: 3, kind: "patch" }],
    ]);
    const result = plan(["L", "P"], [mod("L", { require: ["P"] }), mod("P")], { mode: "tiered", classification });
    expect(result.order).toEqual(["P", "L"]);
  });
});

describe("buildLoadOrderConstraints", () => {
  it("follows require= through a required mod Mods= does not list, and reports it", () => {
    const mods = [mod("A", { require: ["I"] }), mod("I", { require: ["B"] }), mod("B")];
    const built = buildLoadOrderConstraints({ order: ["A", "B"], mods });
    expect(built.constraints).toEqual([
      { before: "B", after: "A", reason: "require", strength: "hard", declaredBy: "I", via: "I" },
    ]);
    expect(built.implicit).toEqual([{ modId: "I", requiredBy: ["A"] }]);
    expect(built.missing).toEqual([{ before: "I", after: "A", reason: "require", why: "missingMod", loadedImplicitly: true }]);
    const result = planLoadOrder({ order: ["A", "B"], ...built });
    expect(result.order).toEqual(["B", "A"]);
    expect(result.implicit).toEqual([{ modId: "I", requiredBy: ["A"] }]);
    expect(result.unsatisfied).toContainEqual({ before: "I", after: "A", reason: "require", why: "missingMod", loadedImplicitly: true });
  });

  it("reports a required mod that is nowhere as missing, not implicit", () => {
    const built = buildLoadOrderConstraints({ order: ["A"], mods: [mod("A", { require: ["Ghost"] })] });
    expect(built.missing).toEqual([{ before: "Ghost", after: "A", reason: "require", why: "missingMod", loadedImplicitly: false }]);
    expect(built.implicit).toEqual([]);
  });

  it("adds loadModAfter=, loadModBefore=, rules, group order, patches, Steam required items and current winners", () => {
    const mods = [
      mod("lib", { workshopId: "100" }),
      mod("a", { workshopId: "200", loadAfter: ["lib"] }),
      mod("b", { workshopId: "200", loadBefore: ["c"] }),
      mod("c", { workshopId: "300" }),
      mod("p", { workshopId: "400" }),
      mod("w", { workshopId: "500" }),
    ];
    const built = buildLoadOrderConstraints({
      order: ["c", "b", "a", "lib", "p", "w"],
      mods,
      rules: [{ id: "r", before: "w", after: "c" }],
      groups: [{ id: "g", name: "G", modIds: ["a", "ghost", "b"] }],
      classification: new Map([["p", { patchOf: ["c"], confidence: "high" }]]),
      steamRequires: new Map([["200", ["100", "200", "999"]]]),
      conflictWinners: [{ winner: "w", loser: "p" }],
    });
    const byPair = new Map(built.constraints.map((c) => [`${c.before}>${c.after}`, c]));
    expect(byPair.get("lib>a")).toMatchObject({ reason: "loadAfter", strength: "strong", reasons: ["loadAfter", "steamRequired"] });
    expect(byPair.get("b>c")).toMatchObject({ reason: "loadBefore", declaredBy: "b" });
    expect(byPair.get("w>c")).toMatchObject({ reason: "rule", strength: "hard", ruleId: "r" });
    expect(byPair.get("a>b")).toMatchObject({ reason: "groupOrder", group: "g" });
    expect(byPair.get("c>p")).toMatchObject({ reason: "patch", source: "classification", confidence: "high" });
    expect(byPair.get("lib>b")).toMatchObject({ reason: "steamRequired", workshopId: "200", requiresWorkshopId: "100" });
    expect(byPair.get("p>w")).toMatchObject({ reason: "conflictWinner" });
    // Sorted strongest first.
    const ranks = built.constraints.map((c) => CONSTRAINT_REASONS[c.reason].rank);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });

  // Seen live (2026-10-20): Tomb's Player Body items list each other as Steam
  // "Required items", and Chuck's alert system item lists errorMagnifier
  // while errorMagnifier require=s the alert system; the plan reported six
  // "could not be met" lines for what is only a subscribe list.
  it("treats Steam Required items as a hint: no edge for mutual items or against require=, never reported", () => {
    const mods = [
      mod("TombBody", { workshopId: "10" }),
      mod("TombCompat", { workshopId: "11" }),
      mod("ChuckAlert", { workshopId: "20" }),
      mod("errorMagnifier", { workshopId: "21", require: ["ChuckAlert"] }),
    ];
    const input = {
      order: ["TombCompat", "TombBody", "ChuckAlert", "errorMagnifier"],
      mods,
      steamRequires: new Map([["10", ["11"]], ["11", ["10"]], ["20", ["21"]]]),
    };
    const built = buildLoadOrderConstraints(input);
    expect(built.constraints.filter((c) => (c.reasons || [c.reason]).includes("steamRequired"))).toEqual([]);
    const plan = planLoadOrder(input);
    expect(plan.unsatisfied).toEqual([]);
    expect(plan.cycles).toEqual([]);
    expect(plan.order).toEqual(input.order);
  });

  it("guesses a patch by name only when nothing is declared", () => {
    const mods = [mod("BritaWeapons", { name: "Brita Weapons" }), mod("BritaWeaponsPatch", { name: "Brita Weapons Patch" })];
    const built = buildLoadOrderConstraints({ order: ["BritaWeaponsPatch", "BritaWeapons"], mods });
    expect(built.constraints).toEqual([
      expect.objectContaining({ before: "BritaWeapons", after: "BritaWeaponsPatch", reason: "patch", source: "name", confidence: "low" }),
    ]);
  });
});

describe("hostile input", () => {
  it("ignores junk entries, duplicates and constraints on absent mods", () => {
    const result = planLoadOrder({
      order: ["A", null, "A", 5, "", "B", { id: "x" }, "C"],
      constraints: [
        { before: "C", after: "A", reason: "require" },
        { before: "Ghost", after: "A", reason: "require" },
        { before: "A", after: "A", reason: "rule" },
        { before: "B", after: "C", reason: "made-up" },
        null,
      ],
    });
    expect(result.order).toEqual(["C", "A", "B"]);
    expect(result.stats.constraints).toBe(1);
    expect(result.changed).toBe(true);
  });

  it("handles odd mod ids (spaces, unicode, regex characters, prototype names)", () => {
    const ids = ["__proto__", "constructor", "a b", "Ümlaut-ß", "(.*)+", "日本語", "toString"];
    const mods = ids.map((id, i) => mod(id, { require: i > 0 ? [ids[i - 1]] : [] }));
    const result = plan([...ids].reverse(), mods);
    expect(result.order).toEqual(ids);
    expect(Object.keys(result.explanations)).toEqual(expect.arrayContaining(["__proto__", "constructor"]));
    expect(plan(result.order, mods).changed).toBe(false);
  });

  it("caps a huge order", () => {
    const ids = Array.from({ length: SMART_SORT_LIMITS.maxMods + 500 }, (_, i) => `m${i}`);
    const result = planLoadOrder({ order: ids, constraints: [] });
    expect(result.order).toHaveLength(SMART_SORT_LIMITS.maxMods);
  });
});

describe("performance", () => {
  it("plans 600 mods with 2000 constraints in under 150 ms", () => {
    const random = rng(42);
    const ids = Array.from({ length: 600 }, (_, i) => `mod_${i}`);
    const reasons = ["require", "loadAfter", "loadBefore", "patch", "steamRequired", "rule", "conflictWinner"];
    const constraints = [];
    const seen = new Set();
    while (constraints.length < 2000) {
      const a = Math.floor(random() * 600);
      const b = Math.floor(random() * 600);
      if (a === b) continue;
      const [x, y] = random() < 0.85 ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)];
      const key = `${x}>${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      constraints.push({ before: ids[x], after: ids[y], reason: reasons[Math.floor(random() * reasons.length)] });
    }
    const groups = Array.from({ length: 20 }, (_, g) => ({
      id: `g${g}`,
      name: `G${g}`,
      modIds: ids.slice(g * 25, g * 25 + 8),
      keepTogether: g % 2 === 0,
    }));
    const order = shuffle(ids, random);
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const result = planLoadOrder({ order, constraints, groups });
      best = Math.min(best, performance.now() - started);
      expect(result.order).toHaveLength(600);
    }
    expect(best).toBeLessThan(150);
  });
});
