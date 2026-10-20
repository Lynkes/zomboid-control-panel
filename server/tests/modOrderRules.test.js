import { describe, expect, it } from "vitest";
import {
  MOD_ORDER_RULE_LIMITS,
  cleanRuleModId,
  findOrderRuleCycle,
  normalizeOrderRule,
  usableOrderRules,
  validateOrderRuleInput,
} from "../utils/modOrderRules.js";

// Order rules (utils/modOrderRules.js): validation and the loop check a new
// rule must pass against the stored rules and require=.

describe("validateOrderRuleInput", () => {
  it("accepts a rule and fills the defaults", () => {
    expect(validateOrderRuleInput({ before: " \\ModA ", after: "ModB" })).toEqual({
      ok: true,
      value: { before: "ModA", after: "ModB", note: "", source: "manual" },
    });
    expect(validateOrderRuleInput({ before: "a", after: "b", note: "  keep b's textures ", source: "conflictResolve" }).value).toEqual({
      before: "a",
      after: "b",
      note: "keep b's textures",
      source: "conflictResolve",
    });
  });

  it("names the field that is wrong", () => {
    expect(validateOrderRuleInput(null)).toEqual({ ok: false, field: "before" });
    expect(validateOrderRuleInput({ before: "a;b", after: "c" })).toEqual({ ok: false, field: "before" });
    expect(validateOrderRuleInput({ before: "a", after: "c=d" })).toEqual({ ok: false, field: "after" });
    expect(validateOrderRuleInput({ before: "a", after: "x\ny" })).toEqual({ ok: false, field: "after" });
    expect(validateOrderRuleInput({ before: "a", after: "\\a" })).toEqual({ ok: false, field: "self" });
    expect(validateOrderRuleInput({ before: "a", after: "b", note: 5 })).toEqual({ ok: false, field: "note" });
    expect(validateOrderRuleInput({ before: "a", after: "b", note: "x".repeat(MOD_ORDER_RULE_LIMITS.noteMax + 1) })).toEqual({
      ok: false,
      field: "note",
    });
    expect(validateOrderRuleInput({ before: "a", after: "b", note: "bell\u0007" })).toEqual({ ok: false, field: "note" });
    expect(validateOrderRuleInput({ before: "a", after: "b", source: "admin" })).toEqual({ ok: false, field: "source" });
    expect(validateOrderRuleInput({ before: "a".repeat(201), after: "b" })).toEqual({ ok: false, field: "before" });
  });

  it("cleans ids like Mods= reads them", () => {
    expect(cleanRuleModId("\\\\Mod With Spaces")).toBe("Mod With Spaces");
    expect(cleanRuleModId("Ünïcode-ß")).toBe("Ünïcode-ß");
    expect(cleanRuleModId("")).toBeNull();
    expect(cleanRuleModId("\u0085")).toBeNull();
    expect(cleanRuleModId(["a"])).toBeNull();
  });
});

describe("stored rules", () => {
  it("answers every field and drops rules that cannot be used", () => {
    expect(normalizeOrderRule({ id: "1", before: "a", after: "b", source: "weird" })).toEqual({
      id: "1",
      before: "a",
      after: "b",
      note: "",
      source: "manual",
      createdBy: null,
      createdAt: null,
    });
    expect(usableOrderRules([{ id: "1", before: "a", after: "b" }, { id: "2", before: "a", after: "a" }, null, { id: "3", before: 1 }])).toHaveLength(1);
  });
});

describe("findOrderRuleCycle", () => {
  const rules = [
    { id: "r1", before: "A", after: "B" },
    { id: "r2", before: "B", after: "C" },
  ];

  it("finds the loop a new rule closes through other rules", () => {
    expect(findOrderRuleCycle({ rules, candidate: { before: "C", after: "A" } })).toEqual({
      cycle: ["C", "A", "B", "C"],
      edges: [
        { before: "C", after: "A", reason: "new" },
        { before: "A", after: "B", reason: "rule", ruleId: "r1" },
        { before: "B", after: "C", reason: "rule", ruleId: "r2" },
      ],
    });
  });

  it("goes through require= links too", () => {
    const found = findOrderRuleCycle({
      rules,
      requireEdges: [{ before: "C", after: "D" }],
      candidate: { before: "D", after: "A" },
    });
    expect(found.cycle).toEqual(["D", "A", "B", "C", "D"]);
    expect(found.edges.at(-1)).toEqual({ before: "C", after: "D", reason: "require" });
  });

  it("is fine without a loop, and leaves out a rule being replaced", () => {
    expect(findOrderRuleCycle({ rules, candidate: { before: "A", after: "C" } })).toBeNull();
    expect(findOrderRuleCycle({ rules, candidate: { before: "B", after: "A" } })).not.toBeNull();
    expect(findOrderRuleCycle({ rules, candidate: { before: "B", after: "A" }, ignoreRuleIds: ["r1"] })).toBeNull();
  });

  it("stays fast on a long chain", () => {
    const chain = Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}`, before: `m${i}`, after: `m${i + 1}` }));
    const started = performance.now();
    const found = findOrderRuleCycle({ rules: chain, candidate: { before: "m2000", after: "m0" } });
    expect(found.cycle).toHaveLength(2002);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
