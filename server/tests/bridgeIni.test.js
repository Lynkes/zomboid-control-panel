import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  addBridgeEntries,
  getChecksumRawValue,
  getEffectiveChecksum,
  hasBridgeEntries,
  insertIniListEntry,
  parseIniList,
  removeBridgeEntries,
  setChecksumFalse,
} from "../utils/bridgeIni.js";
import { writeIniWithBackup } from "../utils/configBackup.js";

// The pure text layer under PanelBridge delivery: every Mods=/WorkshopItems=/
// DoLuaChecksum edit the switch, reconcile and the mods.js guard make goes
// through these helpers, so the cases below are the ones a real server.ini
// throws at them (hand-edited lines, `\`-prefixed ids, missing keys, CRLF).

const MOD = "ZomboidControlPanelBridge";
const ID = "3712345678";

let tmpDir;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("parseIniList / hasBridgeEntries", () => {
  it("treats backslash-prefixed entries as the same mod, the way the game strips them", () => {
    const content = `Mods=\\${MOD};OtherMod\nWorkshopItems=111;${ID}\n`;
    expect(parseIniList(content, "Mods")).toEqual({ present: true, entries: [MOD, "OtherMod"] });
    expect(hasBridgeEntries(content, MOD, ID)).toEqual({ mods: true, workshopItems: true });
  });

  it("drops empty entries and trims whitespace, and tolerates spaces around =", () => {
    expect(parseIniList("Mods = a ; ;b;;\n", "Mods").entries).toEqual(["a", "b"]);
  });

  it("reports a missing key as not present", () => {
    expect(parseIniList("PVP=true\n", "WorkshopItems")).toEqual({ present: false, entries: [] });
    expect(hasBridgeEntries("PVP=true\n", MOD, ID)).toEqual({ mods: false, workshopItems: false });
  });

  it("never reads a key name that only appears inside another field's text", () => {
    const content = `PublicDescription=Mods=${MOD}\nMods=Other\n`;
    expect(parseIniList(content, "Mods").entries).toEqual(["Other"]);
  });

  it("reads the first line by default and, with { last: true }, the line the game applies", () => {
    // The game parses every line in order, so the last duplicate wins.
    const content = `Mods=${MOD}\nWorkshopItems=111;${ID}\nWorkshopItems=111\n`;
    expect(parseIniList(content, "WorkshopItems").entries).toEqual(["111", ID]);
    expect(parseIniList(content, "WorkshopItems", { last: true }).entries).toEqual(["111"]);
    expect(hasBridgeEntries(content, MOD, ID)).toEqual({ mods: true, workshopItems: true });
    expect(hasBridgeEntries(content, MOD, ID, { last: true })).toEqual({ mods: true, workshopItems: false });
    expect(parseIniList("PVP=true\n", "Mods", { last: true })).toEqual({ present: false, entries: [] });
  });
});

describe("addBridgeEntries", () => {
  it("appends both entries to existing lines, bare, keeping the others untouched", () => {
    const next = addBridgeEntries(`Mods=\\ModA;ModB\nWorkshopItems=111\n`, MOD, ID);
    expect(next).toBe(`Mods=\\ModA;ModB;${MOD}\nWorkshopItems=111;${ID}\n`);
  });

  it("fills an empty value without a leading separator and drops a trailing one", () => {
    expect(addBridgeEntries("Mods=\nWorkshopItems=111;\n", MOD, ID)).toBe(`Mods=${MOD}\nWorkshopItems=111;${ID}\n`);
  });

  it("adds a missing key line", () => {
    const next = addBridgeEntries("PVP=true", MOD, ID);
    expect(parseIniList(next, "Mods").entries).toEqual([MOD]);
    expect(parseIniList(next, "WorkshopItems").entries).toEqual([ID]);
  });

  it("never duplicates an entry already present (including a backslash-prefixed one)", () => {
    const content = `Mods=\\${MOD}\nWorkshopItems=${ID}\n`;
    expect(addBridgeEntries(content, MOD, ID)).toBe(content);
  });

  it("does not add a WorkshopItems entry without an id", () => {
    expect(addBridgeEntries("Mods=\nWorkshopItems=\n", MOD, null)).toBe(`Mods=${MOD}\nWorkshopItems=\n`);
  });
});

describe("removeBridgeEntries", () => {
  it("removes exact matches only and keeps the order of everything else", () => {
    const content = `Mods=A;${MOD};B;${MOD}Extra\nWorkshopItems=1;${ID};${ID}0;2\n`;
    expect(removeBridgeEntries(content, MOD, [ID])).toBe(`Mods=A;B;${MOD}Extra\nWorkshopItems=1;${ID}0;2\n`);
  });

  it("removes a backslash-prefixed copy and every old id passed", () => {
    const content = `Mods=\\${MOD};A\nWorkshopItems=999;${ID}\n`;
    expect(removeBridgeEntries(content, MOD, [ID, "999"])).toBe("Mods=A\nWorkshopItems=\n");
  });

  it("removes the entries from every duplicated key line, not just the first", () => {
    const content = `Mods=A;${MOD}\nWorkshopItems=${ID}\nMods=${MOD};B\nWorkshopItems=1;${ID}\n`;
    expect(removeBridgeEntries(content, MOD, [ID])).toBe("Mods=A\nWorkshopItems=\nMods=B\nWorkshopItems=1\n");
  });

  it("leaves a file without the entries byte-for-byte unchanged", () => {
    const content = "Mods = A ; B\nWorkshopItems=1\n";
    expect(removeBridgeEntries(content, MOD, [ID])).toBe(content);
  });
});

describe("DoLuaChecksum", () => {
  it("is true when the key is missing (the game's default)", () => {
    expect(getEffectiveChecksum("PVP=true\n")).toBe(true);
    expect(getChecksumRawValue("PVP=true\n")).toBeNull();
  });

  // 42.20's parser (ConfigFile.read + BooleanConfigOption, javap): the whole
  // line is trimmed, then split on "=" with no per-part trim; true/false/1/0
  // are accepted ignoring case and anything else leaves the default (true).
  it.each([
    ["DoLuaChecksum=false", false],
    ["DoLuaChecksum=False", false],
    ["DoLuaChecksum=0", false],
    ["  DoLuaChecksum=false  ", false],
    ["DoLuaChecksum=true", true],
    ["DoLuaChecksum=1", true],
    ["DoLuaChecksum=", true],
    ["DoLuaChecksum=no", true],
    // A space after "=" makes the value invalid; before "=", the key.
    ["DoLuaChecksum= false", true],
    ["DoLuaChecksum = false", true],
    ["#DoLuaChecksum=false", true],
  ])("reads %j the way the game does (%s)", (line, expected) => {
    expect(getEffectiveChecksum(`PVP=true\n${line}\n`)).toBe(expected);
  });

  it("applies the last valid assignment of a duplicated key, like the game", () => {
    expect(getEffectiveChecksum("DoLuaChecksum=false\nDoLuaChecksum=true\n")).toBe(true);
    expect(getEffectiveChecksum("DoLuaChecksum=true\nDoLuaChecksum=false\n")).toBe(false);
    expect(getEffectiveChecksum("DoLuaChecksum=false\nDoLuaChecksum=garbage\n")).toBe(false);
  });

  it("setChecksumFalse rewrites true, appends a missing key, and leaves an existing false alone", () => {
    expect(setChecksumFalse("DoLuaChecksum=true\nPVP=true\n")).toBe("DoLuaChecksum=false\nPVP=true\n");
    expect(getEffectiveChecksum(setChecksumFalse("PVP=true"))).toBe(false);
    expect(setChecksumFalse("DoLuaChecksum=False\n")).toBe("DoLuaChecksum=False\n");
    expect(setChecksumFalse("DoLuaChecksum=0\n")).toBe("DoLuaChecksum=0\n");
    expect(setChecksumFalse("DoLuaChecksum=true\nDoLuaChecksum=true\n")).toBe(
      "DoLuaChecksum=false\nDoLuaChecksum=false\n",
    );
  });

  it("setChecksumFalse writes a line the game reads, even over one it ignores", () => {
    for (const odd of ["DoLuaChecksum = false", "DoLuaChecksum= false", "\tDoLuaChecksum =true"]) {
      const next = setChecksumFalse(`PVP=true\n${odd}\n`);
      expect(getEffectiveChecksum(next)).toBe(false);
      expect(next).toMatch(/^[ \t]*DoLuaChecksum=false$/m);
    }
    // Java's trim() also strips a leading vertical tab, which the anchored
    // pattern doesn't: the last-valid-wins rule is met by appending.
    const hidden = "DoLuaChecksum=true\n\u000bDoLuaChecksum=true\n";
    expect(setChecksumFalse(hidden)).toBe(`DoLuaChecksum=false\n\u000bDoLuaChecksum=true\nDoLuaChecksum=false\n`);
  });
});

describe("insertIniListEntry", () => {
  it("puts an entry back at its old index, clamped to the list length", () => {
    expect(insertIniListEntry("Mods=A;B\n", "Mods", MOD, 1)).toBe(`Mods=A;${MOD};B\n`);
    expect(insertIniListEntry("Mods=A\n", "Mods", MOD, 5)).toBe(`Mods=A;${MOD}\n`);
  });

  it("restores a missing line", () => {
    expect(parseIniList(insertIniListEntry("PVP=true", "WorkshopItems", ID, 0), "WorkshopItems").entries).toEqual([ID]);
  });
});

describe("CRLF round trip through writeIniWithBackup", () => {
  it("edits LF text and keeps the file's CRLF line endings on disk", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ini-"));
    const iniPath = path.join(tmpDir, "servertest.ini");
    fs.writeFileSync(iniPath, "PVP=true\r\nMods=A\r\nWorkshopItems=1\r\nDoLuaChecksum=true\r\n");
    const lf = fs.readFileSync(iniPath, "utf8").replace(/\r\n/g, "\n");

    await writeIniWithBackup(iniPath, setChecksumFalse(addBridgeEntries(lf, MOD, ID)));

    const onDisk = fs.readFileSync(iniPath, "utf8");
    expect(onDisk).toBe(`PVP=true\r\nMods=A;${MOD}\r\nWorkshopItems=1;${ID}\r\nDoLuaChecksum=false\r\n`);
    expect(fs.readdirSync(path.join(tmpDir, "backups"))).toHaveLength(1);
  });
});
