import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readIniValues,
  mergeIniValues,
  readSandboxValue,
  applySandboxValue,
  mergeSandboxSections,
  backupFile,
  writeFile,
  writeFilesTransaction,
} from "../utils/templateFiles.js";

describe("ini helpers", () => {
  const iniContent = "PVP=true\nMaxPlayers=16\n";

  it("readIniValues reads only the requested keys", () => {
    expect(readIniValues(iniContent, ["PVP", "MaxPlayers", "Missing"])).toEqual({
      PVP: "true",
      MaxPlayers: "16",
    });
  });

  it("mergeIniValues replaces an existing key in place", () => {
    const result = mergeIniValues(iniContent, { MaxPlayers: "32" });
    expect(result).toContain("MaxPlayers=32");
    expect(result).not.toContain("MaxPlayers=16");
  });

  it("mergeIniValues appends a key that doesn't exist yet", () => {
    const result = mergeIniValues(iniContent, { PauseEmpty: true });
    expect(result).toContain("PauseEmpty=true");
  });

  it("mergeIniValues strips newlines from values to prevent injection", () => {
    const result = mergeIniValues(iniContent, { PVP: "false\nRCONPassword=hacked" });
    expect(result).toContain("PVP=falseRCONPassword=hacked");
    expect(result.split("\n").filter((l) => l.startsWith("RCONPassword"))).toHaveLength(0);
  });

  // bughunt-2026-08-31-b: a hand-edited or raw-editor-saved ini can carry
  // "Key = value" (spaces around "="), and serverFiles.js's toIni() no
  // longer silently normalizes that away on save. Neither of these two
  // functions tolerated it until now -- readIniValues returned nothing for
  // the key at all, and mergeIniValues's own regex test failed the same
  // way, so it took the append branch and left a SECOND, unspaced copy of
  // the key instead of replacing the spaced one. No test in this suite
  // exercised any whitespace variant before this, which is exactly why the
  // gap went unnoticed: templateFiles.test.js's own iniContent fixture
  // above has zero whitespace variance anywhere.
  const spacedIniContent = "PVP=true\nMaxPlayers = 16\n";

  it("readIniValues reads a key written with spaces around '='", () => {
    expect(readIniValues(spacedIniContent, ["MaxPlayers"])).toEqual({
      MaxPlayers: "16",
    });
  });

  it("mergeIniValues replaces a spaced key in place instead of appending a duplicate", () => {
    const result = mergeIniValues(spacedIniContent, { MaxPlayers: "32" });
    const maxPlayersLines = result.split("\n").filter((l) => l.startsWith("MaxPlayers"));
    expect(maxPlayersLines).toEqual(["MaxPlayers=32"]);
    expect(result).not.toContain("MaxPlayers = 16");
  });
});

describe("sandbox lua helpers", () => {
  const luaContent = [
    "SandboxVars = {",
    "    VERSION = 4,",
    "    Zombies = 4,",
    "    ZombieLore = {",
    "        Speed = 4,",
    "        Strength = 2,",
    "    },",
    "    MultiplierConfig = {",
    "        Global = 1.0,",
    "    },",
    "}",
    "",
  ].join("\n");

  it("readSandboxValue reads a top-level setting", () => {
    expect(readSandboxValue(luaContent, "settings", "Zombies")).toBe(4);
  });

  it("readSandboxValue reads a nested block value", () => {
    expect(readSandboxValue(luaContent, "ZombieLore", "Speed")).toBe(4);
  });

  it("readSandboxValue returns undefined for a key that isn't present", () => {
    expect(readSandboxValue(luaContent, "ZombieLore", "NotAKey")).toBeUndefined();
  });

  it("readSandboxValue does not confuse a top-level key with a same-named nested key", () => {
    // "Strength" only exists under ZombieLore here — a settings lookup must
    // not accidentally read the nested value.
    expect(readSandboxValue(luaContent, "settings", "Strength")).toBeUndefined();
    expect(readSandboxValue(luaContent, "ZombieLore", "Strength")).toBe(2);
  });

  it("applySandboxValue rewrites a top-level setting without touching same-named nested keys", () => {
    const { content, applied } = applySandboxValue(luaContent, "settings", "Zombies", 2);
    expect(applied).toBe(true);
    expect(readSandboxValue(content, "settings", "Zombies")).toBe(2);
    // ZombieLore.Strength shares no name collision here, but ZombieLore.Speed
    // must survive untouched since we only targeted the top-level key.
    expect(readSandboxValue(content, "ZombieLore", "Speed")).toBe(4);
  });

  it("applySandboxValue rewrites a nested block value", () => {
    const { content, applied } = applySandboxValue(luaContent, "ZombieLore", "Strength", 1);
    expect(applied).toBe(true);
    expect(readSandboxValue(content, "ZombieLore", "Strength")).toBe(1);
  });

  it("applySandboxValue reports applied=false for a key the file doesn't define", () => {
    const { applied } = applySandboxValue(luaContent, "ZombieLore", "NotAKey", 1);
    expect(applied).toBe(false);
  });

  // continuous-bug-hunt round 16 (template apply/import/export truth): same
  // defect class as routes/serverFiles.js's modifySandboxValue (fixed
  // earlier the same day, see that fix's own comment for the full repro) --
  // a SEPARATE, independent implementation of the same "nested-block key
  // rewrite" operation, used specifically by template apply
  // (templateService.js's prepareSandboxChange), was never given the same
  // fix. The nested-block regex's lazy `[^\n]*?` prefix has no boundary
  // check on the left side of the key, so applying a template that sets
  // "Speed" in a block that also has a longer key ENDING in "Speed" earlier
  // in the same block (e.g. "WalkSpeed") matched the key as a bare
  // substring of that longer identifier and silently rewrote WalkSpeed's
  // value instead -- while reporting "Speed" as successfully applied
  // (mergeSandboxSections' `applied` list), even though it never changed.
  it("applySandboxValue updates the exact requested key and leaves a longer key ending in the same substring untouched (does not silently clobber the wrong key)", () => {
    const collisionContent = [
      "SandboxVars = {",
      "    VERSION = 4,",
      "    ZombieLore = {",
      "        WalkSpeed = 1,",
      "        Speed = 2,",
      "    },",
      "}",
      "",
    ].join("\n");

    const { content, applied } = applySandboxValue(
      collisionContent,
      "ZombieLore",
      "Speed",
      9,
    );

    expect(applied).toBe(true);
    expect(readSandboxValue(content, "ZombieLore", "Speed")).toBe(9);
    expect(readSandboxValue(content, "ZombieLore", "WalkSpeed")).toBe(1);
  });

  // Same collision through the actual template-apply path (mergeSandboxSections,
  // called by templateService.js's prepareSandboxChange) -- proves the fix
  // holds through the real caller, not just the lower-level function in
  // isolation, and that "applied" (what an operator sees reported back after
  // an apply) reflects the key that was truly requested.
  it("mergeSandboxSections protects a template apply from the same collision", () => {
    const collisionContent = [
      "SandboxVars = {",
      "    VERSION = 4,",
      "    ZombieLore = {",
      "        WalkSpeed = 1,",
      "        Speed = 2,",
      "    },",
      "}",
      "",
    ].join("\n");

    const { content, applied, skipped } = mergeSandboxSections(collisionContent, {
      ZombieLore: { Speed: 9 },
    });

    expect(skipped).toEqual([]);
    expect(applied).toEqual([{ section: "ZombieLore", key: "Speed" }]);
    expect(readSandboxValue(content, "ZombieLore", "Speed")).toBe(9);
    expect(readSandboxValue(content, "ZombieLore", "WalkSpeed")).toBe(1);
  });

  it("mergeSandboxSections applies every key across sections and reports skips", () => {
    const { content, applied, skipped } = mergeSandboxSections(luaContent, {
      settings: { Zombies: 5 },
      ZombieLore: { Speed: 1, GhostKey: 1 },
      MultiplierConfig: { Global: 2.0 },
    });
    expect(readSandboxValue(content, "settings", "Zombies")).toBe(5);
    expect(readSandboxValue(content, "ZombieLore", "Speed")).toBe(1);
    expect(readSandboxValue(content, "MultiplierConfig", "Global")).toBe(2.0);
    expect(applied).toEqual(
      expect.arrayContaining([
        { section: "settings", key: "Zombies" },
        { section: "ZombieLore", key: "Speed" },
        { section: "MultiplierConfig", key: "Global" },
      ]),
    );
    expect(skipped).toEqual([{ section: "ZombieLore", key: "GhostKey" }]);
  });

  it("formats string values as escaped Lua strings", () => {
    const withString = luaContent.replace(
      "Zombies = 4,",
      'WorldItemRemovalList = "Base.Hat",\n    Zombies = 4,',
    );
    const { content } = applySandboxValue(withString, "settings", "WorldItemRemovalList", 'Base.Hat, Base."Weird"');
    expect(readSandboxValue(content, "settings", "WorldItemRemovalList")).toBe(
      'Base.Hat, Base."Weird"',
    );
  });

  // continuous-bug-hunt round 30 (card: consolidate-nested-sandbox-writer):
  // diffing this writer against its sibling routes/serverFiles.js's
  // modifySandboxValue against a real save (D:/pz-verify) found exactly one
  // behavioral disagreement across nested tables, missing keys, quoting,
  // CRLF and comments: that sibling preserves a field's existing decimal
  // format (writing an integer over a field that was "0.05" produces "3.0",
  // not "3") via formatLuaNumber; this file's formatLuaValue always emitted
  // String(value), silently dropping it. Both parse identically in Lua, but
  // an operator diffing the file (or a tool doing its own string-based
  // scan) sees the field's apparent type change on every template apply
  // that touches it. Fixed to match.
  it("preserves a top-level field's existing decimal format when the new value is a whole number", () => {
    const withFloat = luaContent.replace("Zombies = 4,", "ClayRiverChance = 0.05,\n    Zombies = 4,");
    const { content, applied } = applySandboxValue(withFloat, "settings", "ClayRiverChance", 3);
    expect(applied).toBe(true);
    expect(content).toContain("ClayRiverChance = 3.0,");
  });

  it("preserves a nested block field's existing decimal format the same way", () => {
    const { content, applied } = applySandboxValue(luaContent, "MultiplierConfig", "Global", 2);
    expect(applied).toBe(true);
    expect(content).toContain("Global = 2.0,");
  });

  it("does not add a decimal point when the original field was already a whole number", () => {
    const { content } = applySandboxValue(luaContent, "settings", "Zombies", 7);
    expect(content).toContain("Zombies = 7,");
    expect(content).not.toContain("Zombies = 7.0,");
  });

  // getKnownSectionRanges used to list only 5 of routes/serverFiles.js's 7
  // known nested-block names (missing Music/Debug) -- a same-named key
  // under either block would not have been excluded from a top-level
  // "settings" rewrite here, unlike its sibling. No real save checked
  // defines either block, so this pins the exclusion directly rather than
  // via a real-file fixture.
  it("excludes Music and Debug nested-block contents from a top-level settings rewrite, matching serverFiles.js", () => {
    const withMusicAndDebug = [
      "SandboxVars = {",
      "    Zombies = 4,",
      "    Music = {",
      "        Zombies = 999,",
      "    },",
      "    Debug = {",
      "        Zombies = 888,",
      "    },",
      "}",
      "",
    ].join("\n");

    const { content, applied } = applySandboxValue(withMusicAndDebug, "settings", "Zombies", 5);
    expect(applied).toBe(true);
    expect(readSandboxValue(content, "settings", "Zombies")).toBe(5);
    expect(content).toContain("Zombies = 999,");
    expect(content).toContain("Zombies = 888,");
  });
});

describe("backupFile / writeFile", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-template-files-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the source file doesn't exist", () => {
    expect(backupFile(path.join(dir, "missing.ini"))).toBeNull();
  });

  it("copies the file into a backups/ subdirectory", () => {
    const filePath = path.join(dir, "server.ini");
    fs.writeFileSync(filePath, "PVP=true\n");

    const backupPath = backupFile(filePath);

    expect(backupPath).not.toBeNull();
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf-8")).toBe("PVP=true\n");
    expect(path.dirname(backupPath)).toBe(path.join(dir, "backups"));
  });

  it("disambiguates two backups of the same file landing in the same millisecond", () => {
    const filePath = path.join(dir, "server.ini");
    fs.writeFileSync(filePath, "PVP=true\n");

    // toISOString() is millisecond-resolution; freeze the clock to force
    // the collision deterministically rather than racing real timing.
    const fixedNow = new Date("2026-09-05T12:00:00.000Z");
    const realToISOString = Date.prototype.toISOString;
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
      return realToISOString.call(fixedNow);
    });
    try {
      const firstPath = backupFile(filePath);
      fs.writeFileSync(filePath, "PVP=false\n");
      const secondPath = backupFile(filePath);

      expect(secondPath).not.toBe(firstPath);
      expect(fs.existsSync(firstPath)).toBe(true);
      expect(fs.existsSync(secondPath)).toBe(true);
      expect(fs.readFileSync(firstPath, "utf-8")).toBe("PVP=true\n");
      expect(fs.readFileSync(secondPath, "utf-8")).toBe("PVP=false\n");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("writeFile writes content atomically and readably", () => {
    const filePath = path.join(dir, "out.ini");
    writeFile(filePath, "PVP=true\n");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("PVP=true\n");
  });

  it("rolls back the first file when the second atomic write fails", () => {
    const firstPath = path.join(dir, "first.ini");
    const secondPath = path.join(dir, "second.lua");
    fs.writeFileSync(firstPath, "first-before");
    fs.writeFileSync(secondPath, "second-before");
    const renameSync = fs.renameSync.bind(fs);
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error("simulated second write failure");
      return renameSync(from, to);
    });

    expect(() =>
      writeFilesTransaction([
        {
          filePath: firstPath,
          content: "first-after",
          original: "first-before",
          existed: true,
        },
        {
          filePath: secondPath,
          content: "second-after",
          original: "second-before",
          existed: true,
        },
      ]),
    ).toThrow(/simulated second write failure/);

    renameSpy.mockRestore();
    expect(fs.readFileSync(firstPath, "utf-8")).toBe("first-before");
    expect(fs.readFileSync(secondPath, "utf-8")).toBe("second-before");
  });
});
