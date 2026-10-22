import { describe, expect, it } from "vitest";
import {
  CONFLICT_SUGGESTION_LIMITS,
  createSuggestionContext,
  suggestConflictWinner,
  suggestConflictWinners,
} from "../utils/modConflictSuggestions.js";

// Suggested winners of conflicting pairs (utils/modConflictSuggestions.js):
// a reason when there is one, nothing when there is not.

const pair = (a, b, files = [{ file: "lua/client/x.lua", severity: "high", kind: "lua-override" }], extra = {}) => ({
  modA: { modId: a, workshopId: "1", modName: a },
  modB: { modId: b, workshopId: "2", modName: b },
  files,
  aWins: 0,
  bWins: files.length,
  ...extra,
});

function ctx(fields) {
  return createSuggestionContext({ effectiveOrder: ["A", "B"], ...fields });
}

describe("suggestConflictWinner", () => {
  it("a stored order rule decides (high)", () => {
    const c = ctx({ mods: [{ id: "A" }, { id: "B" }], rules: [{ id: "r1", before: "B", after: "A" }] });
    expect(suggestConflictWinner(pair("A", "B"), c)).toEqual({
      winner: "A",
      confidence: "high",
      reason: "rule",
      alreadyWinning: false,
      params: { ruleId: "r1" },
    });
  });

  it("the mod that require=s the other wins, also through other mods", () => {
    const c = ctx({ mods: [{ id: "A", require: ["Mid"] }, { id: "Mid", require: ["B"] }, { id: "B" }] });
    expect(suggestConflictWinner(pair("A", "B"), c)).toMatchObject({ winner: "A", confidence: "high", reason: "requiresOther", alreadyWinning: false });
  });

  it("a declared loadModAfter= (or the other's loadModBefore=) wins", () => {
    expect(suggestConflictWinner(pair("A", "B"), ctx({ mods: [{ id: "A" }, { id: "B", loadAfter: ["A"] }] }))).toMatchObject({
      winner: "B",
      reason: "declaresLoadAfter",
      alreadyWinning: true,
    });
    expect(suggestConflictWinner(pair("A", "B"), ctx({ mods: [{ id: "A" }, { id: "B", loadBefore: ["A"] }] }))).toMatchObject({
      winner: "A",
      reason: "declaresLoadAfter",
    });
  });

  it("a recognised patch wins with the classifier's confidence", () => {
    const classification = new Map([["B", { kind: "patch", patchOf: ["A"], confidence: "medium" }]]);
    expect(suggestConflictWinner(pair("A", "B"), ctx({ mods: [{ id: "A" }, { id: "B" }], classification }))).toMatchObject({
      winner: "B",
      confidence: "medium",
      reason: "patchOfOther",
    });
  });

  it("a translation mod wins translation files only", () => {
    const classification = new Map([["A", { kind: "translation", patchOf: [] }], ["B", { kind: "content", patchOf: [] }]]);
    const files = [{ file: "lua/shared/translate/en/ui.json", severity: "low", kind: "translation-override", category: "translate" }];
    const c = ctx({ mods: [{ id: "A" }, { id: "B" }], classification });
    expect(suggestConflictWinner(pair("A", "B", files), c)).toMatchObject({ winner: "A", reason: "translation", confidence: "medium" });
    expect(suggestConflictWinner(pair("A", "B"), c)).toBeNull();
  });

  it("a small mod overriding a big one on purpose wins", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ file: `lua/client/f${i}.lua`, severity: "high" }));
    const c = ctx({ mods: [{ id: "A" }, { id: "B" }], fileCounts: new Map([["A", 500], ["B", 8]]) });
    expect(suggestConflictWinner(pair("A", "B", files), c)).toEqual({
      winner: "B",
      confidence: "medium",
      reason: "smallOverride",
      alreadyWinning: true,
      params: { files: 8, conflicting: 6, otherFiles: 500 },
    });
    // Not small enough, or not a big share of its files: no signal.
    const L = CONFLICT_SUGGESTION_LIMITS;
    expect(suggestConflictWinner(pair("A", "B", files), ctx({ mods: [], fileCounts: new Map([["A", 5000], ["B", L.smallMaxFiles + 1]]) }))).toBeNull();
    expect(suggestConflictWinner(pair("A", "B", files.slice(0, 1)), c)).toBeNull();
  });

  it("two mods of one Workshop item follow the author's Mod ID order (low)", () => {
    const c = ctx({
      mods: [{ id: "A", workshopId: "9" }, { id: "B", workshopId: "9" }],
      modIdOrder: new Map([["9", ["B", "A"]]]),
    });
    expect(suggestConflictWinner(pair("A", "B"), c)).toMatchObject({ winner: "A", confidence: "low", reason: "sameWorkshopItem", params: { workshopId: "9" } });
  });

  it("no signal, no suggestion (never a guess); none for a declared incompatibility", () => {
    expect(suggestConflictWinner(pair("A", "B"), ctx({ mods: [{ id: "A" }, { id: "B" }] }))).toBeNull();
    const incompatible = [{ file: "mod.info", severity: "high", kind: "declared-incompatible" }];
    expect(suggestConflictWinner(pair("A", "B", incompatible), ctx({ mods: [{ id: "A", require: ["B"] }, { id: "B" }] }))).toBeNull();
  });

  it("ignores a require= loop and broken pairs", () => {
    const c = ctx({ mods: [{ id: "A", require: ["B"] }, { id: "B", require: ["A"] }] });
    expect(suggestConflictWinner(pair("A", "B"), c)).toBeNull();
    expect(suggestConflictWinner({ modA: null, modB: { modId: "B" } }, c)).toBeNull();
    expect(suggestConflictWinner(pair("A", "A"), c)).toBeNull();
  });
});

describe("suggestConflictWinners", () => {
  it("sets suggestion on the pairs that have one and replaces a stale one", () => {
    const c = ctx({ mods: [{ id: "A", require: ["B"] }, { id: "B" }, { id: "C" }] });
    const out = suggestConflictWinners([pair("A", "B"), { ...pair("B", "C"), suggestion: { winner: "C" } }], c);
    expect(out[0].suggestion).toMatchObject({ winner: "A", reason: "requiresOther" });
    expect(out[1]).not.toHaveProperty("suggestion");
  });
});
