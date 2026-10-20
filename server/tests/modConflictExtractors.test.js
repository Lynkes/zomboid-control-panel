import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  extractClothingOutfits,
  extractLuaGlobals,
  extractScriptDefinitionBodies,
  extractTranslationEntries,
} from "../utils/modDefinitionExtractors.js";
import {
  cachedFileHash,
  cachedParse,
  clearConflictFileCache,
  compareScriptFileCopies,
  compareTranslationEntries,
  gameMediaDirs,
  isNonGameplayMediaFile,
} from "../utils/modConflictRules.js";

// The readers behind the conflict rules (game-accurate translations, script
// definitions with bodies, Lua globals, clothing outfits), the file-kind and
// folder rules, and the per-file cache. Workshop files are someone else's
// content, so every reader also gets a hostile input that must stay fast.

let dir;
let counter = 0;
function file(content, ext = ".txt") {
  const p = path.join(dir, `f${counter++}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-conflict-extractors-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("translations", () => {
  it("reads a B42 JSON translation as key -> value", () => {
    const entries = extractTranslationEntries(file('﻿{ "UI_A": "a", "UI_N": 3, "UI_E": "" }', ".json"));
    expect([...entries]).toEqual([["UI_A", "a"], ["UI_N", "3"], ["UI_E", ""]]);
  });

  it("falls back to pair by pair for JSON the strict parser refuses (org.json is lenient)", () => {
    const entries = extractTranslationEntries(file('{\n  "UI_A": "a \\"quoted\\"",\n  "UI_B": "b",\n}\n', ".json"));
    expect(entries.get("UI_A")).toBe('a "quoted"');
    expect(entries.get("UI_B")).toBe("b");
  });

  it("returns null for a file it cannot read as a translation", () => {
    expect(extractTranslationEntries(file("not json at all", ".json"))).toBeNull();
  });

  it("compares values: an empty value never counts, only differing values conflict", () => {
    const result = compareTranslationEntries([
      { modId: "A", entries: new Map([["K", "one"], ["S", "same"]]) },
      { modId: "B", entries: new Map([["K", "two"], ["S", "same"]]) },
      { modId: "C", entries: new Map([["K", ""]]) },
    ]);
    expect(result).toEqual({ conflicting: ["K"], modIds: ["A", "B"], sameValue: 1, unreadable: false, unreadableModIds: [] });
  });
});

describe("script definitions with bodies", () => {
  it("takes only blocks directly inside a module, keyed module.type.name", () => {
    const defs = extractScriptDefinitionBodies(
      file(
        [
          "module Base {",
          "  imports { Base }",
          "  craftRecipe MakeBox {",
          "    inputs { item 1 [Base.Nails], item 2 [Base.Plank], }",
          "  }",
          "  item Box { Weight = 1, }",
          "  template vehicle Trunk { part TruckBed { } }",
          "  vehicle Van { mass = 800, }",
          "  xuiSkin default { }",
          "}",
        ].join("\n"),
      ),
    );
    expect([...defs.keys()].sort()).toEqual([
      "Base.craftrecipe.MakeBox",
      "Base.item.Box",
      "Base.template vehicle.Trunk",
      "Base.vehicle.Van",
      "Base.xuiskin.default",
    ]);
    expect(defs.get("Base.vehicle.Van").merged).toBe(true);
    expect(defs.get("Base.xuiskin.default").merged).toBe(true);
    expect(defs.get("Base.template vehicle.Trunk").merged).toBe(false);
    expect(defs.get("Base.item.Box").merged).toBe(false);
  });

  it("ignores formatting and slash-star comments in a body's digest", () => {
    const a = extractScriptDefinitionBodies(file("module Base { item Box { Weight = 1, } }"));
    const b = extractScriptDefinitionBodies(file("module Base {\n /* x */ item Box\n {\n\tWeight = 1,\n }\n}"));
    const c = extractScriptDefinitionBodies(file("module Base { item Box { Weight = 2, } }"));
    expect(a.get("Base.item.Box").hash).toBe(b.get("Base.item.Box").hash);
    expect(c.get("Base.item.Box").hash).not.toBe(a.get("Base.item.Box").hash);
  });

  it("lists what a dropped copy loses and what the winner overrides", () => {
    const winner = new Map([["X.item.A", { hash: "1" }], ["X.item.B", { hash: "2" }]]);
    const loser = new Map([["X.item.A", { hash: "1" }], ["X.item.B", { hash: "9" }], ["X.item.C", { hash: "3" }]]);
    expect(compareScriptFileCopies(winner, loser)).toEqual({ lost: ["X.item.C"], overridden: ["X.item.B"], same: 1 });
  });
});

describe("Lua globals", () => {
  it("lists global functions, classes and tables, not locals, parameters or chained hooks", () => {
    const globals = extractLuaGlobals(
      file(
        [
          "local M = {}",
          "local a, b = 1, 2",
          "function M.init() end",
          "local function helper(player) player.onDeath = function() end end",
          "function GlobalFn() end",
          "MyMod = {}",
          "MyMod.tick = function() end",
          "ISMyPanel = ISPanel:derive(\"ISMyPanel\")",
          "function ISMyPanel:render() end",
          "local original = ISInventoryPane.refresh",
          "function ISInventoryPane:refresh(...) return original(self, ...) end",
          "function ISToolTip:render() end",
          "Events.OnTick.Add(helper)",
          "-- function Commented() end",
        ].join("\n"),
        ".lua",
      ),
    );
    expect([...globals].sort()).toEqual([
      "class:ISMyPanel",
      "fn:GlobalFn",
      "fn:ISMyPanel.render",
      "fn:ISToolTip.render",
      "fn:MyMod.tick",
      "tbl:MyMod",
    ]);
  });
});

describe("clothing.xml outfits", () => {
  it("keys each outfit by gender and name", () => {
    const outfits = extractClothingOutfits(
      file(
        "<outfitManager><m_MaleOutfits><m_Name>Biker</m_Name><x>1</x></m_MaleOutfits>" +
          "<m_FemaleOutfits><m_Name>Biker</m_Name></m_FemaleOutfits><m_MaleOutfits><m_Name> Cop </m_Name></m_MaleOutfits></outfitManager>",
        ".xml",
      ),
    );
    expect([...outfits.keys()]).toEqual(["male:Biker", "male:Cop", "female:Biker"]);
  });
});

describe("files and folders", () => {
  it("knows which media files the game never reads", () => {
    for (const p of ["readme.txt", "lua/README.md", "license", "changelog.txt", ".gitkeep", "textures/thumbs.db", "desktop.ini", "poster.png", "preview.jpg", "mod.info", "workshop.txt"]) {
      expect(isNonGameplayMediaFile(p), p).toBe(true);
    }
    for (const p of ["ui/icon.png", "textures/poster.png", "scripts/readme.txt", "lua/shared/license.lua", "sandbox-options.txt"]) {
      expect(isNonGameplayMediaFile(p), p).toBe(false);
    }
  });

  it("picks the folders B42 loads", () => {
    const root = fs.mkdtempSync(path.join(dir, "mod-"));
    for (const sub of ["media", "common/media", "42/media", "42.5/media", "43/media", "41/media"]) {
      fs.mkdirSync(path.join(root, sub), { recursive: true });
    }
    expect(gameMediaDirs(root)).toEqual({
      layout: "b42",
      dirs: [path.join(root, "common", "media"), path.join(root, "42.5", "media")],
      versionFolder: "42.5",
    });
    const legacy = fs.mkdtempSync(path.join(dir, "legacy-"));
    fs.mkdirSync(path.join(legacy, "media"));
    fs.mkdirSync(path.join(legacy, "41"));
    expect(gameMediaDirs(legacy)).toEqual({ layout: "legacy", dirs: [path.join(legacy, "media")], versionFolder: null });
  });

  it("caches hashes and parses by path + size + mtime", async () => {
    clearConflictFileCache();
    const p = file("aaaa", ".bin");
    const mtime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(p, mtime, mtime);
    const first = await cachedFileHash(p);
    fs.writeFileSync(p, "bbbb"); // same size
    fs.utimesSync(p, mtime, mtime); // same mtime: the cached answer stands
    expect(await cachedFileHash(p)).toBe(first);
    const later = new Date(mtime.getTime() + 5000);
    fs.utimesSync(p, later, later);
    expect(await cachedFileHash(p)).not.toBe(first);

    let calls = 0;
    const extractor = () => ++calls;
    cachedParse("kind", p, extractor);
    cachedParse("kind", p, extractor);
    expect(calls).toBe(1);
  });
});

describe("hostile input finishes fast", () => {
  const fast = (fn) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("translation fallback on a long line of quotes", () => {
    const p = file(`{${'"a" '.repeat(300_000)}`, ".json");
    expect(fast(() => extractTranslationEntries(p))).toBeLessThan(2000);
  });

  it("Lua locals, parameters and captures", () => {
    const p = file(
      `local ${"a,".repeat(200_000)}\nfunction f(${"x,".repeat(100_000)}\n= ${"A.".repeat(100_000)}\n${" ".repeat(500_000)}`,
      ".lua",
    );
    expect(fast(() => extractLuaGlobals(p))).toBeLessThan(2000);
  });

  it("scripts full of braces", () => {
    const p = file(`module Base { ${"item X { ".repeat(50_000)}${"}".repeat(50_000)} }`);
    expect(fast(() => extractScriptDefinitionBodies(p))).toBeLessThan(2000);
  });
});
