import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Scope cases the old regex editors got wrong (#197 follow-through), driven
// through the same exported entry points the routes use, plus round trips of
// the real vanilla B42 file.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const { parseSandboxVars, applySandboxChanges, modifySandboxValue, checkSandboxBraceBalance } =
  await import("../routes/serverFiles.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// SandboxVars.lua as game build 42.21 writes it (SandboxOptions.writeLuaFile,
// default values, English tooltips, CRLF). Byte-exact: see .gitattributes.
const VANILLA_CRLF = fs.readFileSync(
  path.join(__dirname, "../__fixtures__/pzVanillaB42SandboxVars.lua"),
  "utf-8",
);
const VANILLA_LF = VANILLA_CRLF.replace(/\r\n/g, "\n");

const lua = (...lines) => [...lines, ""].join("\n");

describe("same-named keys at three depths, with a sub-table inside a block", () => {
  const content = lua(
    "SandboxVars = {",
    "    Speed = 1,",
    "    ZombieLore = {",
    "        Advanced = {",
    "            Speed = 3,",
    "        },",
    "        Speed = 2,",
    "    },",
    "}",
  );

  it("a top-level write touches only the top-level key", () => {
    expect(modifySandboxValue(content, "Speed", 7, null)).toBe(
      content.replace("    Speed = 1,", "    Speed = 7,"),
    );
  });

  it("a block write skips the sub-table and lands on the block's own key", () => {
    expect(modifySandboxValue(content, "Speed", 8, "ZombieLore")).toBe(
      content.replace("        Speed = 2,", "        Speed = 8,"),
    );
  });

  it("parse reports depths one and two only, and a full save round-trips", () => {
    const parsed = parseSandboxVars(content);
    expect(parsed.settings).toEqual({ Speed: 1 });
    expect(parsed.ZombieLore).toEqual({ Speed: 2 });
    expect(applySandboxChanges(content, parsed)).toBe(content);
  });
});

describe("strings and comments are not structure", () => {
  const content = lua(
    "SandboxVars = {",
    '    Banner = "a { b } -- c = d",',
    "    -- tooltip: default {fast} = 2",
    "    ZombieLore = {",
    '        Label = "x}",',
    "        --[[",
    "        Speed = 9,",
    "        ]]",
    "        -- Speed = 8,",
    "        Speed = 2,",
    "    },",
    "}",
  );

  it("parse reads strings with braces, dashes and '=' exactly and ignores commented-out keys", () => {
    const parsed = parseSandboxVars(content);
    expect(parsed.settings).toEqual({ Banner: "a { b } -- c = d" });
    expect(parsed.ZombieLore).toEqual({ Label: "x}", Speed: 2 });
  });

  it("a block write finds the real key past a brace in a string and a block comment", () => {
    expect(modifySandboxValue(content, "Speed", 5, "ZombieLore")).toBe(
      content.replace("        Speed = 2,", "        Speed = 5,"),
    );
  });

  it("a string value with braces and dashes round-trips through a save", () => {
    const written = applySandboxChanges(content, { settings: { Banner: "}{ --[[ = ]]" } });
    expect(parseSandboxVars(written).settings.Banner).toBe("}{ --[[ = ]]");
    expect(parseSandboxVars(written).ZombieLore).toEqual({ Label: "x}", Speed: 2 });
  });

  it("brace counting skips strings and comments", () => {
    expect(checkSandboxBraceBalance(content)).toEqual({ balanced: true, depth: 0 });
  });
});

describe("a block whose name is a suffix of another block's name", () => {
  const content = lua(
    "SandboxVars = {",
    "    ZombieLore = {",
    "        Speed = 2,",
    "    },",
    "    Lore = {",
    "        Speed = 1,",
    "    },",
    "}",
  );

  it("writes Lore.Speed, not ZombieLore.Speed", () => {
    expect(modifySandboxValue(content, "Speed", 9, "Lore")).toBe(
      content.replace("        Speed = 1,", "        Speed = 9,"),
    );
  });

  it("parses both blocks under their own names", () => {
    const parsed = parseSandboxVars(content);
    expect(parsed.Lore).toEqual({ Speed: 1 });
    expect(parsed.ZombieLore).toEqual({ Speed: 2 });
  });
});

describe("quoted keys, duplicates and trailing separators", () => {
  const content = lua(
    "SandboxVars = {",
    '    ["Zombies"] = 4;',
    "    Map = { AllowMiniMap = false, AllowMiniMap = true, },",
    "}",
  );

  it('treats ["Zombies"] as Zombies and the last duplicate as the value the game uses', () => {
    const parsed = parseSandboxVars(content);
    expect(parsed.settings.Zombies).toBe(4);
    expect(parsed.Map.AllowMiniMap).toBe(true);
    expect(modifySandboxValue(content, "Zombies", 2, null)).toBe(
      content.replace('["Zombies"] = 4;', '["Zombies"] = 2;'),
    );
    expect(modifySandboxValue(content, "AllowMiniMap", false, "Map")).toBe(
      content.replace("AllowMiniMap = true,", "AllowMiniMap = false,"),
    );
  });
});

describe("the real vanilla B42 SandboxVars.lua layout", () => {
  it.each([
    ["CRLF", VANILLA_CRLF],
    ["LF", VANILLA_LF],
  ])("parses every block (%s)", (_eol, content) => {
    const parsed = parseSandboxVars(content);
    expect(parsed.VERSION).toBe(6);
    expect(Object.keys(parsed).sort()).toEqual(
      ["Basement", "Debug", "Map", "MultiplierConfig", "Music", "VERSION", "ZombieConfig", "ZombieLore", "settings"].sort(),
    );
    expect(parsed.settings.Zombies).toBe(4);
    expect(parsed.settings.WorldItemRemovalList).toMatch(/^Base\.Hat, Base\.Glasses/);
    expect(parsed.ZombieLore.Speed).toBe(4);
    expect(parsed.MultiplierConfig.Global).toBe(1);
    expect(parsed.Map.AllowWorldMap).toBe(true);
    // Keys shared between the top level and a block stay apart.
    expect(parsed.settings.Farming).toBeDefined();
    expect(parsed.MultiplierConfig.Farming).toBe(1);
  });

  it.each([
    ["CRLF", VANILLA_CRLF],
    ["LF", VANILLA_LF],
  ])("saving the parse result back is byte-for-byte identical (%s)", (_eol, content) => {
    expect(applySandboxChanges(content, parseSandboxVars(content))).toBe(content);
  });

  it.each([
    ["CRLF", VANILLA_CRLF],
    ["LF", VANILLA_LF],
  ])("one change per section rewrites only those values (%s)", (eol, content) => {
    const eolChar = eol === "CRLF" ? "\r\n" : "\n";
    const changes = {
      settings: { Zombies: 2, FoodLootNew: 3, WorldItemRemovalList: "Base.Hat" },
      ZombieLore: { Speed: 1 },
      MultiplierConfig: { Farming: 2.5 },
      Map: { AllowMiniMap: true },
    };
    const written = applySandboxChanges(content, changes);
    const expected = content
      .replace(`    Zombies = 4,${eolChar}`, `    Zombies = 2,${eolChar}`)
      .replace("    FoodLootNew = 0.8,", "    FoodLootNew = 3.0,")
      .replace(/ {4}WorldItemRemovalList = "[^"]*",/, '    WorldItemRemovalList = "Base.Hat",')
      .replace(`        Speed = 4,${eolChar}`, `        Speed = 1,${eolChar}`)
      .replace("        Farming = 1.0,", "        Farming = 2.5,")
      .replace("        AllowMiniMap = false,", "        AllowMiniMap = true,");
    expect(written).toBe(expected);
    // The top-level Farming enum is untouched by MultiplierConfig.Farming.
    expect(parseSandboxVars(written).settings.Farming).toBe(parseSandboxVars(content).settings.Farming);
  });

  it("round-trips with the #197 mod tables appended", () => {
    const withMods = VANILLA_CRLF.replace(
      /\}\r\n$/,
      [
        "    LootTweaks = {",
        "        Explosives = 1.0,",
        "    },",
        "    Explosives = {",
        "        VanillaBallisticsEnabled = false,",
        "    },",
        "}",
        "",
      ].join("\r\n"),
    );
    const parsed = parseSandboxVars(withMods);
    expect(parsed.settings.Explosives).toBeUndefined();
    expect(applySandboxChanges(withMods, parsed)).toBe(withMods);
  });
});
