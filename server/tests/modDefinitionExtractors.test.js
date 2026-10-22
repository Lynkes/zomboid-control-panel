import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_DEFINITION_FILE_CHARS,
  extractClothingDefinitions,
  extractLuaSymbols,
  extractScriptDefinitions,
  extractTranslationKeys,
  stripLuaBlockComments,
} from "../utils/modDefinitionExtractors.js";

// Security audit 2026-10-20: the mod conflict scanner's extractors (moved
// here from routes/mods.js) used regexes that backtracked super-linearly on
// hostile Workshop files and froze the panel: "<m_MaleModel>" and 6 KB of
// spaces took 52 s, 100 KB of blank lines in a .lua 21 s. They are now
// linear and size-capped. The golden cases below pin the results the old
// patterns gave on ordinary files (also checked against ~32,000 files of the
// game's media folder and 202 Workshop mods: no difference).

let dir;
let counter = 0;
function file(content, ext = ".txt") {
  const p = path.join(dir, `f${counter++}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
const sorted = (set) => (set === null ? null : [...set].sort());

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-extractors-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("golden results on ordinary mod files", () => {
  it("translation keys", () => {
    const content = [
      "﻿IGUI_EN = {",
      '    IGUI_perks_Lightfoot = "Lightfoot",',
      "\tIGUI_Tab = 'tab'",
      "",
      "",
      "  UI_Long = [[multi",
      "line]],",
      'Sandbox_X="no spaces",',
      "Spaced  =   \"wide\",",
      "  NotAString = 12,",
      "  Nested = {",
      "-- Commented = \"still matched by the old pattern\",",
      "}",
    ].join("\r\n");
    expect(sorted(extractTranslationKeys(file(content)))).toEqual(
      ["IGUI_Tab", "IGUI_perks_Lightfoot", "Sandbox_X", "Spaced", "UI_Long"].sort(),
    );
  });

  it("script definitions", () => {
    const content = [
      "module Base",
      "{",
      "    imports { Base }",
      "    item BaseballBat",
      "    {",
      "        DisplayName = Baseball Bat,",
      "    }",
      "",
      "",
      "    craftRecipe MakeBat { inputs { item 1 [Base.Plank] } }",
      "\tRecipe   Saw Logs",
      "    {",
      "    }",
      "    model BatModel { mesh = x }",
      "}",
      "module Other {",
      "    vehicle Car1 { }",
      "    fixing Fix_Car",
      "    {",
      "    }",
      "}",
      "module Unclosed {",
      "    item Last",
    ].join("\r\n");
    expect(sorted(extractScriptDefinitions(file(content)))).toEqual(
      [
        "Base.craftrecipe.MakeBat",
        "Base.item.BaseballBat",
        "Base.model.BatModel",
        "Base.recipe.Saw",
        "Other.fixing.Fix_Car",
        "Other.vehicle.Car1",
        "Unclosed.item.Las", // an unclosed module drops the file's last character
      ].sort(),
    );
  });

  it("an unclosed module drops its last character, as before", () => {
    expect(sorted(extractScriptDefinitions(file("module M {\n item Abc")))).toEqual(["M.item.Ab"]);
  });

  it("clothing definitions", () => {
    const content = [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<clothingItem>",
      "  <m_MaleModel>skinned\\clothes\\Shirt_Male</m_MaleModel>",
      "  <m_FemaleModel>",
      "     skinned\\clothes\\Shirt_Female  ",
      "  </m_FemaleModel>",
      "  <M_MALEMODEL>Upper</M_MALEMODEL>",
      "  <m_MaleModel></m_MaleModel>",
      "  <m_Name>Base.Shirt</m_Name>",
      "  <m_Name>   </m_Name>",
      "</clothingItem>",
    ].join("\n");
    expect(sorted(extractClothingDefinitions(file(content, ".xml")))).toEqual(
      ["", "base.shirt", "skinned\\clothes\\shirt_female", "skinned\\clothes\\shirt_male", "upper"].sort(),
    );
  });

  it("Lua symbols", () => {
    const content = [
      "require 'ISUI/ISPanel'",
      "--[[ function Hidden() end",
      "  Events.OnHidden.Add(x) ]]",
      "-- function AlsoHidden()",
      "MyMod = MyMod or {}",
      "",
      "",
      "local function helper(a) end",
      "function MyMod.init() end",
      "  function MyMod:onTick(t) end",
      "MyMod.handler = function(x) end",
      "ISMyPanel = ISPanel:derive(\"ISMyPanel\")",
      "Events.OnGameStart.Add(MyMod.init)",
      "Events.OnTick.Remove(MyMod.onTick)",
      "x = 1; function NotAtLineStart() end",
      "--[[ unclosed opener keeps the rest",
      "function AfterUnclosed() end",
    ].join("\r\n");
    expect(sorted(extractLuaSymbols(file(content, ".lua")))).toEqual(
      [
        "class:ISMyPanel",
        "event:OnGameStart",
        "event:OnTick",
        "fn:AfterUnclosed",
        "fn:MyMod.handler",
        "fn:MyMod.init",
        "fn:MyMod:onTick",
        "fn:helper",
      ].sort(),
    );
  });

  it("strips block comments exactly as the old replace did", () => {
    const cases = [
      "a --[[ x ]] b --[[ y ]] c",
      "--[[ open --[[ nested ]] after ]]",
      "--[[ never closed",
      "x --[[ a ]] y --[[ never closed ]",
      "]] --[[]] --[[ ]]]",
      "",
    ];
    for (const text of cases) expect(stripLuaBlockComments(text)).toBe(text.replace(/--\[\[[\s\S]*?\]\]/g, ""));
  });
});

describe("hostile input finishes fast", () => {
  const timed = (fn) => {
    const started = performance.now();
    const result = fn();
    return { result, ms: performance.now() - started };
  };
  const big = MAX_DEFINITION_FILE_CHARS - 64;

  it.each([
    ["<m_MaleModel> + 6000 spaces (52 s before)", "<m_MaleModel>" + " ".repeat(6000)],
    ["<m_MaleModel> + 2 MB of spaces", "<m_MaleModel>" + " ".repeat(big)],
    ["<m_Name> + 2 MB of spaces", "<m_Name>" + " ".repeat(big)],
    ["many openers", "<m_FemaleModel> x".repeat(big / 20)],
  ])("clothing: %s", (_label, content) => {
    const { ms } = timed(() => extractClothingDefinitions(file(content, ".xml")));
    expect(ms).toBeLessThan(200);
  });

  it.each([
    ["2 MB of blank lines", "\n".repeat(big)],
    ["blank lines of spaces", " \n".repeat(big / 2)],
    ["a key then 2 MB of whitespace", "KEY" + " \n".repeat(big / 2)],
  ])("translation: %s", (_label, content) => {
    const { ms } = timed(() => extractTranslationKeys(file(content)));
    expect(ms).toBeLessThan(200);
  });

  it.each([
    ["2 MB of blank lines (21 s for 100 KB before)", "\n".repeat(big)],
    ["unterminated --[[ openers", "--[[".repeat(big / 4)],
    ["local and blank lines", "local" + "\n".repeat(big - 8)],
    ["indented blank lines", "\n\t ".repeat(big / 3)],
    ["an identifier then whitespace", "Foo" + " \n".repeat(big / 2)],
  ])("Lua: %s", (_label, content) => {
    const { ms } = timed(() => extractLuaSymbols(file(content, ".lua")));
    expect(ms).toBeLessThan(200);
  });

  it.each([
    ["module{ + 2 MB of blank lines", "module Base {" + "\n".repeat(big)],
    ["module{ + whitespace lines", "module Base {" + "  \n".repeat(big / 3)],
    ["200,000 unclosed nested modules", "module A {".repeat(big / 10)],
    ["a keyword then whitespace", "module Base {\nitem" + " \n".repeat(big / 2)],
  ])("scripts: %s", (_label, content) => {
    const { result, ms } = timed(() => extractScriptDefinitions(file(content)));
    expect(ms).toBeLessThan(200);
    expect(result === null || result instanceof Set).toBe(true);
  });
});

describe("size caps", () => {
  it("refuses a file over the cap (null: the pair stays a conflict)", () => {
    const over = "x".repeat(MAX_DEFINITION_FILE_CHARS + 1);
    expect(extractTranslationKeys(file(over))).toBeNull();
    expect(extractScriptDefinitions(file(over))).toBeNull();
    expect(extractClothingDefinitions(file(over, ".xml"))).toBeNull();
    expect(extractLuaSymbols(file(over, ".lua"))).toBeNull();
  });

  it("refuses a hostile nest of modules whose bodies add up past the scan budget", () => {
    expect(extractScriptDefinitions(file("module A {".repeat(100_000)))).toBeNull();
  });
});
