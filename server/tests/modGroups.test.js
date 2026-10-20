import { describe, expect, it } from "vitest";
import {
  MOD_GROUP_LIMITS,
  applyModGroups,
  cleanGroupModIds,
  groupsInOrder,
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

describe("groupsInOrder", () => {
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
