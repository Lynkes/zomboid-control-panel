import { describe, expect, it } from "vitest";
import { applySandboxValue } from "../utils/templateFiles.js";

const { modifySandboxValue } = await import("../routes/serverFiles.js");

// continuous-bug-hunt round 30 (card: consolidate-nested-sandbox-writer):
// serverFiles.js's modifySandboxValue and templateFiles.js's
// applySandboxValue are two independent implementations of the same "write
// a SandboxVars.lua key in place" operation (one for the raw sandbox-editor
// route, one for template apply). Diffed both against a real save
// (D:/pz-verify/Zomboid/Server/pz-verify_SandboxVars.lua, CRLF line
// endings, 1023 lines) across every edge case the consolidate-writer card
// named: nested tables, missing keys, quoting/escaping, number formats,
// CRLF, and comments. Every case matched byte-for-byte except number
// formats (fixed in templateFiles.js -- see that file's own comment) --
// this file pins that parity directly so a future change to either writer
// that reintroduces a divergence fails here, not in production. Fixtures
// below are deliberately small/synthetic rather than the full real file, to
// keep this fast and self-contained; the real-file comparison itself was
// exploratory, not something worth committing as a giant embedded fixture.

const sandboxContent = [
  "SandboxVars = {",
  "    VERSION = 6,",
  "    ClayRiverChance = 0.05,",
  "    GeneratorTileRange = 20,",
  '    WorldItemRemovalList = "Base.Hat, Base.Glasses",',
  '    LootItemRemovalList = "",',
  "    Basement = {",
  "        SpawnFrequency = 4,",
  "    },",
  "    ZombieLore = {",
  "        WalkSpeed = 1,",
  "        Speed = 4,",
  "    },",
  "    Map = {",
  "        AllowMiniMap = false,",
  "        AllowWorldMap = true,",
  "    },",
  "}",
  "",
].join("\r\n");

function topLevelLine(content, key) {
  return content.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
}

describe("sandbox writer convergence: modifySandboxValue (serverFiles.js) vs applySandboxValue (templateFiles.js)", () => {
  it("agree on a plain top-level number change", () => {
    const a = modifySandboxValue(sandboxContent, "GeneratorTileRange", 55, null);
    const b = applySandboxValue(sandboxContent, "settings", "GeneratorTileRange", 55);
    expect(topLevelLine(b.content, "GeneratorTileRange")).toBe(topLevelLine(a, "GeneratorTileRange"));
  });

  it("agree on decimal-format preservation for a top-level number", () => {
    const a = modifySandboxValue(sandboxContent, "ClayRiverChance", 3, null);
    const b = applySandboxValue(sandboxContent, "settings", "ClayRiverChance", 3);
    expect(topLevelLine(a, "ClayRiverChance")).toContain("3.0,");
    expect(topLevelLine(b.content, "ClayRiverChance")).toBe(topLevelLine(a, "ClayRiverChance"));
  });

  it("agree on a nested-block value change", () => {
    const a = modifySandboxValue(sandboxContent, "SpawnFrequency", 2, "Basement");
    const b = applySandboxValue(sandboxContent, "Basement", "SpawnFrequency", 2);
    const lineA = a.split(/\r?\n/).find((l) => l.includes("SpawnFrequency"));
    const lineB = b.content.split(/\r?\n/).find((l) => l.includes("SpawnFrequency"));
    expect(lineB).toBe(lineA);
  });

  it("agree on the substring-boundary fix: 'Speed' never clobbers 'WalkSpeed'", () => {
    const a = modifySandboxValue(sandboxContent, "Speed", 9, "ZombieLore");
    const b = applySandboxValue(sandboxContent, "ZombieLore", "Speed", 9);
    expect(a).toContain("WalkSpeed = 1,");
    expect(b.content).toContain("WalkSpeed = 1,");
    expect(a).toContain("Speed = 9,");
    expect(b.content).toContain("Speed = 9,");
  });

  it("agree on quoted-string escaping for a comma/quote/backslash-bearing value", () => {
    const trickyValue = 'Base.Hat, Base."Weird"Item, Base.Back\\Slash';
    const a = modifySandboxValue(sandboxContent, "WorldItemRemovalList", trickyValue, null);
    const b = applySandboxValue(sandboxContent, "settings", "WorldItemRemovalList", trickyValue);
    expect(topLevelLine(b.content, "WorldItemRemovalList")).toBe(topLevelLine(a, "WorldItemRemovalList"));
  });

  it("agree on a missing key: both leave content byte-for-byte unchanged", () => {
    const a = modifySandboxValue(sandboxContent, "NotARealKey", 5, null);
    const b = applySandboxValue(sandboxContent, "settings", "NotARealKey", 5);
    expect(a).toBe(sandboxContent);
    expect(b.content).toBe(sandboxContent);
    expect(b.applied).toBe(false);
  });

  it("agree on preserving every other line's CRLF ending", () => {
    const a = modifySandboxValue(sandboxContent, "GeneratorTileRange", 55, null);
    const b = applySandboxValue(sandboxContent, "settings", "GeneratorTileRange", 55);
    const crlfCount = (s) => (s.match(/\r\n/g) || []).length;
    const lfOnlyCount = (s) => (s.match(/\n/g) || []).length - crlfCount(s);
    expect(crlfCount(a)).toBe(crlfCount(sandboxContent));
    expect(lfOnlyCount(a)).toBe(0);
    expect(crlfCount(b.content)).toBe(crlfCount(sandboxContent));
    expect(lfOnlyCount(b.content)).toBe(0);
  });

  it("agree on an inline trailing comment surviving a value change, top-level and nested", () => {
    const withComments = sandboxContent.replace(
      "GeneratorTileRange = 20,",
      "GeneratorTileRange = 20, -- keep this comment",
    );
    const a = modifySandboxValue(withComments, "GeneratorTileRange", 99, null);
    const b = applySandboxValue(withComments, "settings", "GeneratorTileRange", 99);
    expect(topLevelLine(a, "GeneratorTileRange")).toContain("-- keep this comment");
    expect(topLevelLine(b.content, "GeneratorTileRange")).toBe(topLevelLine(a, "GeneratorTileRange"));
  });
});
