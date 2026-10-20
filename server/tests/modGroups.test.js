import { describe, expect, it } from "vitest";
import {
  MOD_GROUP_COLORS,
  MOD_GROUP_LIMITS,
  applyModGroups,
  cleanGroupModIds,
  groupsInOrder,
  normalizeGroup,
  uniqueGroupName,
  validateGroupDocument,
  validateGroupFields,
} from "../utils/modGroups.js";

// Mod groups: a named, ordered list of mod IDs whose order is the load order
// they must keep in Mods=. applyModGroups() puts a list into that order by
// permuting the slots the members already occupy, so nothing else moves.

const group = (id, ...modIds) => ({ id, name: id, description: "", modIds });

describe("applyModGroups", () => {
  it("leaves a list alone when every group is already in order", () => {
    const input = ["a", "x", "b", "y", "c"];
    const result = applyModGroups(input, [group("g", "a", "b", "c")]);
    expect(result).toEqual({ order: input, moved: [], conflicts: [] });
  });

  it("gives the members of a group the slots they hold, in the group's order, and never moves a non-member", () => {
    const result = applyModGroups(["c", "x", "a", "y", "b", "z"], [group("g", "a", "b", "c")]);
    expect(result.order).toEqual(["a", "x", "b", "y", "c", "z"]);
    expect(result.moved).toEqual(["a", "b", "c"]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not require the members to end up next to each other", () => {
    const result = applyModGroups(["b", "x", "x2", "a"], [group("g", "a", "b")]);
    expect(result.order).toEqual(["a", "x", "x2", "b"]);
  });

  it("does not return the input array and does not change it", () => {
    const input = ["b", "a"];
    const result = applyModGroups(input, [group("g", "a", "b")]);
    expect(input).toEqual(["b", "a"]);
    expect(result.order).not.toBe(input);
  });

  it("orders only the members that are present and ignores the ones that are not installed", () => {
    const result = applyModGroups(["c", "x", "a"], [group("g", "a", "missing", "b", "c")]);
    expect(result.order).toEqual(["a", "x", "c"]);
    expect(result.moved).toEqual(["a", "c"]);
  });

  it("changes nothing for a group with fewer than two present members", () => {
    const input = ["z", "a", "y"];
    expect(applyModGroups(input, [group("one", "a")]).order).toEqual(input);
    expect(applyModGroups(input, [group("none", "q", "r")]).order).toEqual(input);
    expect(applyModGroups(input, [group("half", "a", "q")]).order).toEqual(input);
    expect(applyModGroups(input, [group("empty")]).order).toEqual(input);
  });

  it("handles an empty list, no groups and malformed input", () => {
    expect(applyModGroups([], [group("g", "a", "b")])).toEqual({ order: [], moved: [], conflicts: [] });
    expect(applyModGroups(["a"], [])).toEqual({ order: ["a"], moved: [], conflicts: [] });
    expect(applyModGroups(undefined, undefined)).toEqual({ order: [], moved: [], conflicts: [] });
    expect(applyModGroups(["b", "a"], [null, { id: "bad" }, group("g", "a", "b")]).order).toEqual(["a", "b"]);
  });

  it("applies two groups that do not share a mod independently", () => {
    const result = applyModGroups(
      ["b1", "a2", "x", "a1", "b2"],
      [group("a", "a1", "a2"), group("b", "b1", "b2")],
    );
    expect(result.order).toEqual(["b1", "a1", "x", "a2", "b2"]);
    expect(result.conflicts).toEqual([]);
  });

  it("satisfies groups that share mods when their orders agree, repeating the pass when a later group shifts an earlier one", () => {
    // a chain a < b < c < d split over three groups, handed over reversed
    const groups = [group("g1", "a", "b"), group("g2", "b", "c"), group("g3", "c", "d")];
    const result = applyModGroups(["d", "c", "b", "a"], groups);
    expect(result.order).toEqual(["a", "b", "c", "d"]);
    expect(result.conflicts).toEqual([]);
    for (const status of groupsInOrder(result.order, groups)) expect(status.inOrder).toBe(true);
  });

  it("reports the groups that contradict each other and keeps the result of the last pass", () => {
    const groups = [group("g1", "a", "b"), group("g2", "b", "a")];
    const result = applyModGroups(["a", "b", "x"], groups);
    expect(result.conflicts).toEqual(["g1"]);
    // the last group applied wins
    expect(result.order).toEqual(["b", "a", "x"]);
  });

  it("is idempotent", () => {
    const groups = [group("g1", "lib", "core", "addon"), group("g2", "core", "fix")];
    const once = applyModGroups(["fix", "addon", "x", "core", "lib"], groups);
    const twice = applyModGroups(once.order, groups);
    expect(twice.order).toEqual(once.order);
    expect(twice.moved).toEqual([]);
  });

  it("keeps the KI5 example in order: library, core mods, add-ons, fixes, interleaved with unrelated mods", () => {
    const ki5 = group("ki5", "KI5lib", "KI5core1", "KI5core2", "KI5addonA", "KI5addonB", "KI5fix");
    const input = [
      "Authentic",
      "KI5fix",
      "KI5core2",
      "Hydrocraft",
      "KI5addonB",
      "KI5lib",
      "Brita",
      "KI5core1",
      "KI5addonA",
      "Tail",
    ];
    const result = applyModGroups(input, [ki5]);
    // the six KI5 slots were 1, 2, 4, 5, 7, 8 and keep their places
    expect(result.order).toEqual([
      "Authentic",
      "KI5lib",
      "KI5core1",
      "Hydrocraft",
      "KI5core2",
      "KI5addonA",
      "Brita",
      "KI5addonB",
      "KI5fix",
      "Tail",
    ]);
    expect(result.moved).toEqual(["KI5lib", "KI5core1", "KI5core2", "KI5addonA", "KI5addonB", "KI5fix"]);
    for (const id of ["Authentic", "Hydrocraft", "Brita", "Tail"]) {
      expect(result.order.indexOf(id)).toBe(input.indexOf(id));
    }
  });

  it("treats a group's repeated ids once and leaves a duplicate entry of the list where it is", () => {
    const result = applyModGroups(["b", "a", "b"], [group("g", "a", "b", "a")]);
    expect(result.order).toEqual(["a", "b", "b"]);
    expect(result.moved).toEqual(["a", "b"]);
  });

  it("matches mod ids exactly, including ones made of digits", () => {
    const result = applyModGroups(["3519629457", "Alpha", "alpha"], [group("g", "alpha", "3519629457")]);
    expect(result.order).toEqual(["alpha", "Alpha", "3519629457"]);
  });
});

describe("applyModGroups with keepTogether", () => {
  const together = (id, ...modIds) => ({ ...group(id, ...modIds), keepTogether: true });

  it("makes one block at the first member's slot and moves the mods that were between right after it", () => {
    const result = applyModGroups(["x", "c", "y", "a", "z", "b", "w"], [together("g", "a", "b", "c")]);
    // c held the first slot (1): a, b, c fill 1-3, then y and z in their old order
    expect(result.order).toEqual(["x", "a", "b", "c", "y", "z", "w"]);
    expect(result.moved).toEqual(["a", "b", "c", "y", "z"]);
    expect(result.conflicts).toEqual([]);
  });

  it("leaves a block that is already together and in order alone", () => {
    const input = ["x", "a", "b", "c", "y"];
    expect(applyModGroups(input, [together("g", "a", "b", "c")])).toEqual({ order: input, moved: [], conflicts: [] });
  });

  it("only gathers the members that are present and ignores a group with fewer than two", () => {
    expect(applyModGroups(["a", "x", "c"], [together("g", "a", "missing", "c")]).order).toEqual(["a", "c", "x"]);
    expect(applyModGroups(["a", "x"], [together("g", "a", "missing")]).order).toEqual(["a", "x"]);
  });

  it("keeps a repeated entry of a member, moving it after the block", () => {
    const result = applyModGroups(["a", "x", "a", "b"], [together("g", "a", "b")]);
    expect(result.order).toEqual(["a", "b", "x", "a"]);
  });

  it("is idempotent", () => {
    const groups = [together("g1", "lib", "core", "addon"), group("g2", "core", "fix")];
    const once = applyModGroups(["fix", "addon", "x", "core", "y", "lib"], groups);
    expect(applyModGroups(once.order, groups)).toEqual({ order: once.order, moved: [], conflicts: [] });
  });

  it("keeps keepTogether: false exactly as before (members only trade slots)", () => {
    const input = ["c", "x", "a", "y", "b", "z"];
    const plain = applyModGroups(input, [group("g", "a", "b", "c")]);
    const off = applyModGroups(input, [{ ...group("g", "a", "b", "c"), keepTogether: false }]);
    expect(off).toEqual(plain);
    expect(off.order).toEqual(["a", "x", "b", "y", "c", "z"]);
  });

  it("KI5 example: the pack kept together, a fixes group sharing a mod with it, a weapons group that is not", () => {
    const groups = [
      together("ki5", "KI5lib", "KI5core1", "KI5core2", "KI5addonA", "KI5fix"),
      group("weapons", "Brita", "Arsenal"),
      group("fixes", "KI5fix", "BritaFix"),
    ];
    const input = [
      "Authentic",
      "KI5fix",
      "Arsenal",
      "KI5core2",
      "Hydrocraft",
      "BritaFix",
      "KI5lib",
      "Brita",
      "KI5core1",
      "KI5addonA",
      "Tail",
    ];
    const result = applyModGroups(input, groups);
    expect(result.order).toEqual([
      "Authentic",
      // the KI5 block at the slot KI5fix held, in the group's order
      "KI5lib",
      "KI5core1",
      "KI5core2",
      "KI5addonA",
      "KI5fix",
      // what was between the KI5 mods, in its old order; Brita and Arsenal
      // traded their slots (weapons is not kept together)
      "Brita",
      "Hydrocraft",
      "BritaFix",
      "Arsenal",
      "Tail",
    ]);
    expect(result.conflicts).toEqual([]);
    for (const status of groupsInOrder(result.order, groups)) expect(status.inOrder).toBe(true);
    expect(result.order.indexOf("Authentic")).toBe(0);
    expect(result.order.indexOf("Tail")).toBe(input.length - 1);
  });

  it("reports two groups kept together that cannot both be one block", () => {
    const groups = [together("g1", "a", "b"), together("g2", "a", "c")];
    const result = applyModGroups(["a", "x", "b", "c"], groups);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.order).toHaveLength(4);
    expect([...result.order].sort()).toEqual(["a", "b", "c", "x"]);
  });
});

describe("groupsInOrder", () => {
  it("calls a group kept together out of order while its members are apart, even in the right order", () => {
    const kept = { ...group("g", "a", "b"), keepTogether: true };
    expect(groupsInOrder(["a", "x", "b"], [kept])[0].inOrder).toBe(false);
    expect(groupsInOrder(["x", "a", "b"], [kept])[0].inOrder).toBe(true);
    expect(groupsInOrder(["a", "x"], [kept])[0].inOrder).toBe(true);
    expect(groupsInOrder(["a", "x", "b"], [group("g", "a", "b")])[0].inOrder).toBe(true);
  });

  it("reports in-order, present, total and the missing ids per group", () => {
    const groups = [group("ok", "a", "b"), group("bad", "b", "a", "gone"), group("solo", "a", "q")];
    expect(groupsInOrder(["a", "x", "b"], groups)).toEqual([
      { id: "ok", inOrder: true, present: 2, total: 2, missing: [] },
      { id: "bad", inOrder: false, present: 2, total: 3, missing: ["gone"] },
      { id: "solo", inOrder: true, present: 1, total: 2, missing: ["q"] },
    ]);
  });

  it("counts a group with no installed member as in order", () => {
    expect(groupsInOrder([], [group("g", "a", "b")])).toEqual([
      { id: "g", inOrder: true, present: 0, total: 2, missing: ["a", "b"] },
    ]);
  });

  it("does not call a group out of order because of mods that are in no group", () => {
    expect(groupsInOrder(["z", "a", "y", "b"], [group("g", "a", "b")])[0].inOrder).toBe(true);
  });
});

describe("validateGroupFields", () => {
  const good = { name: "KI5 Vehicles", description: "Cars", modIds: ["lib", "core"] };

  it("cleans a valid group", () => {
    expect(validateGroupFields({ name: "  KI5  ", modIds: ["a", " b ", "a"] })).toEqual({
      ok: true,
      value: { name: "KI5", description: "", modIds: ["a", "b"] },
    });
  });

  it("names the first field that is wrong", () => {
    expect(validateGroupFields({ ...good, name: "" })).toEqual({ ok: false, field: "name" });
    expect(validateGroupFields({ ...good, name: "   " })).toEqual({ ok: false, field: "name" });
    expect(validateGroupFields({ ...good, name: 5 })).toEqual({ ok: false, field: "name" });
    expect(validateGroupFields({ ...good, name: "x".repeat(MOD_GROUP_LIMITS.nameMax + 1) })).toEqual({
      ok: false,
      field: "name",
    });
    expect(validateGroupFields({ ...good, name: `bad${String.fromCharCode(7)}name` })).toEqual({
      ok: false,
      field: "name",
    });
    expect(validateGroupFields({ ...good, description: "x".repeat(MOD_GROUP_LIMITS.descriptionMax + 1) })).toEqual({
      ok: false,
      field: "description",
    });
    expect(validateGroupFields({ ...good, description: 7 })).toEqual({ ok: false, field: "description" });
    expect(validateGroupFields({ ...good, modIds: [] })).toEqual({ ok: false, field: "modIds" });
    expect(validateGroupFields({ ...good, modIds: "a" })).toEqual({ ok: false, field: "modIds" });
    expect(validateGroupFields(null)).toEqual({ ok: false, field: "name" });
  });

  it("accepts the limits themselves", () => {
    const ids = Array.from({ length: MOD_GROUP_LIMITS.modIdsMax }, (_, i) => `mod${i}`);
    const result = validateGroupFields({
      name: "n".repeat(MOD_GROUP_LIMITS.nameMax),
      description: "d".repeat(MOD_GROUP_LIMITS.descriptionMax),
      modIds: ids,
    });
    expect(result.ok).toBe(true);
    expect(result.value.modIds).toHaveLength(MOD_GROUP_LIMITS.modIdsMax);
  });

  it("takes a colour from the palette (or null) and a keepTogether boolean, only when given", () => {
    expect(MOD_GROUP_COLORS).toEqual(["slate", "red", "orange", "amber", "lime", "green", "teal", "sky", "blue", "violet", "pink"]);
    for (const color of [...MOD_GROUP_COLORS, null]) {
      expect(validateGroupFields({ ...good, color }).value.color).toBe(color);
    }
    expect(validateGroupFields({ ...good, keepTogether: true }).value.keepTogether).toBe(true);
    expect(validateGroupFields({ ...good, keepTogether: false }).value.keepTogether).toBe(false);
    expect(validateGroupFields(good).value).not.toHaveProperty("color");
    expect(validateGroupFields(good).value).not.toHaveProperty("keepTogether");
    expect(validateGroupFields({ color: "red" }, { partial: true })).toEqual({ ok: true, value: { color: "red" } });
    expect(validateGroupFields({ keepTogether: true }, { partial: true })).toEqual({ ok: true, value: { keepTogether: true } });
  });

  it("refuses another colour or a keepTogether that is not a boolean", () => {
    for (const color of ["purple", "Red", "", 3, true, ["red"], {}]) {
      expect(validateGroupFields({ ...good, color })).toEqual({ ok: false, field: "color" });
      expect(validateGroupFields({ color }, { partial: true })).toEqual({ ok: false, field: "color" });
    }
    for (const keepTogether of ["true", 1, 0, null, {}]) {
      expect(validateGroupFields({ ...good, keepTogether })).toEqual({ ok: false, field: "keepTogether" });
    }
  });

  it("only checks the fields that are given for an update", () => {
    expect(validateGroupFields({}, { partial: true })).toEqual({ ok: true, value: {} });
    expect(validateGroupFields({ modIds: ["a"] }, { partial: true })).toEqual({
      ok: true,
      value: { modIds: ["a"] },
    });
    expect(validateGroupFields({ name: "" }, { partial: true })).toEqual({ ok: false, field: "name" });
    expect(validateGroupFields({ description: null }, { partial: true })).toEqual({
      ok: true,
      value: { description: "" },
    });
  });
});

describe("cleanGroupModIds", () => {
  it("keeps all-digit ids and drops duplicates (first wins)", () => {
    expect(cleanGroupModIds(["3519629457", "b", "3519629457"])).toEqual(["3519629457", "b"]);
  });

  it("removes backslashes the way the game does before it reads Mods=", () => {
    expect(cleanGroupModIds(["\\Alpha", "Beta"])).toEqual(["Alpha", "Beta"]);
  });

  it("refuses ids that would break the ini line or are out of range", () => {
    for (const bad of ["a;b", "a=b", "a\nb", "a\rb", "", "  ", "x".repeat(MOD_GROUP_LIMITS.modIdMax + 1), "\\", 5, null]) {
      expect(cleanGroupModIds(["fine", bad])).toBeNull();
    }
    expect(cleanGroupModIds(Array.from({ length: MOD_GROUP_LIMITS.modIdsMax + 1 }, (_, i) => `m${i}`))).toBeNull();
  });
});

describe("validateGroupDocument", () => {
  const doc = { schema: 1, kind: "zcp-mod-group", name: "KI5", description: "d", modIds: ["a", "b"] };

  it("accepts a mod group export", () => {
    expect(validateGroupDocument(doc)).toEqual({
      ok: true,
      value: { name: "KI5", description: "d", modIds: ["a", "b"] },
    });
    expect(validateGroupDocument({ ...doc, description: undefined }).value.description).toBe("");
  });

  it("carries a valid colour and keepTogether, and drops ones this version does not know", () => {
    expect(validateGroupDocument({ ...doc, color: "teal", keepTogether: true }).value).toEqual({
      name: "KI5",
      description: "d",
      modIds: ["a", "b"],
      color: "teal",
      keepTogether: true,
    });
    expect(validateGroupDocument({ ...doc, color: null, keepTogether: false }).value).toMatchObject({
      color: null,
      keepTogether: false,
    });
    const unknown = validateGroupDocument({ ...doc, color: "ultraviolet", keepTogether: "yes" });
    expect(unknown.ok).toBe(true);
    expect(unknown.value).toEqual({ name: "KI5", description: "d", modIds: ["a", "b"] });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "text",
      [],
      { ...doc, kind: "other" },
      { ...doc, kind: undefined },
      { ...doc, schema: 2 },
      { ...doc, schema: "1" },
      { ...doc, name: "" },
      { ...doc, modIds: [] },
      { ...doc, modIds: ["a;b"] },
    ]) {
      expect(validateGroupDocument(bad)).toEqual({ ok: false });
    }
  });
});

describe("normalizeGroup", () => {
  it("reads a group saved before colours and keepTogether existed as color null, keepTogether false", () => {
    const old = { id: "g", name: "Old", description: "", modIds: ["a"], createdAt: "t", updatedAt: "t" };
    expect(normalizeGroup(old)).toEqual({ ...old, color: null, keepTogether: false });
    expect(old).not.toHaveProperty("color");
  });

  it("keeps valid values and replaces unknown ones", () => {
    expect(normalizeGroup({ id: "g", color: "sky", keepTogether: true })).toMatchObject({ color: "sky", keepTogether: true });
    expect(normalizeGroup({ id: "g", color: "mauve", keepTogether: "yes" })).toMatchObject({ color: null, keepTogether: false });
  });
});

describe("uniqueGroupName", () => {
  it("keeps a free name and suffixes a taken one", () => {
    expect(uniqueGroupName("KI5", ["Other"])).toBe("KI5");
    expect(uniqueGroupName("KI5", ["KI5"])).toBe("KI5 (2)");
    expect(uniqueGroupName("KI5", ["ki5", "KI5 (2)"])).toBe("KI5 (3)");
  });

  it("stays within the name limit", () => {
    const long = "n".repeat(MOD_GROUP_LIMITS.nameMax);
    const result = uniqueGroupName(long, [long]);
    expect(result.length).toBeLessThanOrEqual(MOD_GROUP_LIMITS.nameMax);
    expect(result.endsWith(" (2)")).toBe(true);
  });
});
