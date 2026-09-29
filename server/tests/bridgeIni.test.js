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
  listsIniEntry,
  parseIniList,
  readGameIniList,
  removeBridgeEntries,
  setChecksumFalse,
} from "../utils/bridgeIni.js";
import { writeIniWithBackup } from "../utils/configBackup.js";

// The pure text layer under PanelBridge delivery: every Mods=/WorkshopItems=/
// DoLuaChecksum edit the switch, reconcile and the mods.js guard make goes
// through these helpers, so the cases below are the ones a real server.ini
// throws at them (hand-edited lines, `\`-prefixed ids, missing keys, CRLF).

const MOD = "ZCPB";
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

  it("drops empty entries and trims whitespace; the writers' reading finds a `Key =` line too", () => {
    expect(parseIniList("Mods = a ; ;b;;\n", "Mods").entries).toEqual(["a", "b"]);
  });

  it("reports a missing key as not present", () => {
    expect(parseIniList("PVP=true\n", "WorkshopItems")).toEqual({ present: false, entries: [] });
    expect(readGameIniList("PVP=true\n", "WorkshopItems")).toEqual({ present: false, entries: [] });
    expect(hasBridgeEntries("PVP=true\n", MOD, ID)).toEqual({ mods: false, workshopItems: false });
  });

  it("never reads a key name that only appears inside another field's text", () => {
    const content = `PublicDescription=Mods=${MOD}\nMods=Other\n`;
    expect(parseIniList(content, "Mods").entries).toEqual(["Other"]);
    expect(readGameIniList(content, "Mods").entries).toEqual(["Other"]);
  });

  it("parseIniList reads the first line (the one the writers edit); the game applies the last", () => {
    // ServerOptions parses every line in order, so the last duplicate wins.
    const content = `Mods=${MOD}\nWorkshopItems=111;${ID}\nWorkshopItems=111\n`;
    expect(parseIniList(content, "WorkshopItems").entries).toEqual(["111", ID]);
    expect(readGameIniList(content, "WorkshopItems").entries).toEqual(["111"]);
    expect(hasBridgeEntries(content, MOD, ID)).toEqual({ mods: true, workshopItems: false });
  });
});

// 42.20, javap: ConfigFile.read trims each line (Java trim), skips blank,
// `#` and "="-less lines, then split("=") with no per-part trim, so the
// option name must be exactly "Mods"/"WorkshopItems" and the value ends at
// the next "=". GameServer.main then strips every "\" from Mods= only;
// WorkshopItems= tokens are trimmed and must pass SteamUtils.isValidSteamID
// (new BigInteger(token)) as they stand. A Mods= id is then looked up
// exactly, case included (ChooseGameInfo.getModDetails: a HashMap key, then
// String.equals against each mod.info id).
describe("hasBridgeEntries / readGameIniList: as the game reads the file", () => {
  it.each([
    ["plain lines", `Mods=${MOD}\nWorkshopItems=${ID}\n`, true, true],
    ["the mod id in another case (a different mod to the game)", `Mods=${MOD.toLowerCase()}\nWorkshopItems=${ID}\n`, false, true],
    ["a backslash-prefixed mod id (Mods= loses every \\)", `Mods=\\${MOD}\nWorkshopItems=${ID}\n`, true, true],
    ["a backslash-prefixed item id (not a Steam id)", `Mods=${MOD}\nWorkshopItems=111;\\${ID}\n`, true, false],
    ["whitespace before = on Mods (option \"Mods \")", `Mods =${MOD}\nWorkshopItems=${ID}\n`, false, true],
    ["whitespace before = on WorkshopItems", `Mods=${MOD}\nWorkshopItems\t=111;${ID}\n`, true, false],
    ["indented lines (the whole line is trimmed)", `  Mods=${MOD}\n\u000bWorkshopItems=${ID}\n`, true, true],
    ["spaces around each token", `Mods= A ; ${MOD} \nWorkshopItems= ${ID} ;\n`, true, true],
    ["an item id with a leading zero (the same number)", `Mods=${MOD}\nWorkshopItems=0${ID}\n`, true, true],
    ["an item id with trailing junk", `Mods=${MOD}\nWorkshopItems=${ID}x\n`, true, false],
    ["a commented-out line", `#Mods=${MOD}\nWorkshopItems=${ID}\n`, false, true],
    ["a second = cutting the value short", `Mods=A=B;${MOD}\nWorkshopItems=${ID}\n`, false, true],
    ["a duplicated key (the last line wins)", `Mods=${MOD}\nMods=A\nWorkshopItems=${ID}\n`, false, true],
    ["a lone CR ending a line", `Mods=${MOD}\rWorkshopItems=${ID}\n`, true, true],
  ])("%s", (_label, content, mods, workshopItems) => {
    expect(hasBridgeEntries(content, MOD, ID)).toEqual({ mods, workshopItems });
  });

  it("keeps only valid Steam ids in WorkshopItems, in plain decimal form", () => {
    const content = "WorkshopItems=1;18446744073709551616;-5;+7;\\8;0042;x9;18446744073709551615\n";
    expect(readGameIniList(content, "WorkshopItems").entries).toEqual(["1", "7", "42", "18446744073709551615"]);
  });

  it("ignores a `Key =` line entirely rather than reading its value", () => {
    expect(readGameIniList("Mods = a;b\n", "Mods")).toEqual({ present: false, entries: [] });
    expect(readGameIniList("Mods = a;b\nMods=c\n", "Mods").entries).toEqual(["c"]);
  });

  it("does not count a bridge id that is missing or unusable", () => {
    expect(hasBridgeEntries(`Mods=${MOD}\nWorkshopItems=${ID}\n`, MOD, null)).toEqual({ mods: true, workshopItems: false });
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

  it("never duplicates an entry the game already reads (a backslash-prefixed mod id, a zero-padded item id)", () => {
    const content = `Mods=\\${MOD}\nWorkshopItems=0${ID}\n`;
    expect(addBridgeEntries(content, MOD, ID)).toBe(content);
  });

  it("adds the exact mod id next to one in another case, which the game doesn't load as the bridge", () => {
    const lower = MOD.toLowerCase();
    const next = addBridgeEntries(`Mods=${lower}\nWorkshopItems=${ID}\n`, MOD, ID);
    expect(next).toBe(`Mods=${lower};${MOD}\nWorkshopItems=${ID}\n`);
    expect(hasBridgeEntries(next, MOD, ID)).toEqual({ mods: true, workshopItems: true });
  });

  it("does not add a WorkshopItems entry without an id", () => {
    expect(addBridgeEntries("Mods=\nWorkshopItems=\n", MOD, null)).toBe(`Mods=${MOD}\nWorkshopItems=\n`);
  });

  // A `Key =` line is an option the game doesn't have: appending to it
  // as-is would "succeed" and change nothing the game reads.
  it("rewrites a `Key =` line as `Key=` so the game reads it", () => {
    const next = addBridgeEntries(`Mods=OtherMod\nWorkshopItems =111\n`, MOD, ID);
    expect(next).toBe(`Mods=OtherMod;${MOD}\nWorkshopItems=111;${ID}\n`);
    expect(hasBridgeEntries(next, MOD, ID)).toEqual({ mods: true, workshopItems: true });
  });

  it("rewrites the key even when that line already lists the entry", () => {
    const next = addBridgeEntries(`\tMods \t= A;${MOD}\nWorkshopItems=${ID}\n`, MOD, ID);
    expect(next).toBe(`\tMods=A;${MOD}\nWorkshopItems=${ID}\n`);
    expect(hasBridgeEntries(next, MOD, ID)).toEqual({ mods: true, workshopItems: true });
  });

  it("adds the bare item id next to a backslash-prefixed one the game drops", () => {
    const next = addBridgeEntries(`Mods=OtherMod\nWorkshopItems=111;\\${ID}\n`, MOD, ID);
    expect(next).toBe(`Mods=OtherMod;${MOD}\nWorkshopItems=111;\\${ID};${ID}\n`);
    expect(hasBridgeEntries(next, MOD, ID)).toEqual({ mods: true, workshopItems: true });
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

  // Over-removal is safe: a `\`-prefixed or zero-padded copy of the item id
  // goes too. A `Key =` line keeps its spacing, so a line the game ignored
  // doesn't start counting because an entry left it.
  it("removes every spelling of the item id, and keeps a `Key =` line's spacing", () => {
    const content = `Mods =A;${MOD}\nWorkshopItems=\\${ID};0${ID};1\n`;
    expect(removeBridgeEntries(content, MOD, [ID])).toBe("Mods =A\nWorkshopItems=1\n");
  });
});

describe("listsIniEntry", () => {
  it("is true exactly when the removal would take the entry out of some line", () => {
    expect(listsIniEntry(`Mods=A\nMods=${MOD}\n`, "Mods", MOD)).toBe(true);
    expect(listsIniEntry(`WorkshopItems=\\${ID}\n`, "WorkshopItems", ID)).toBe(true);
    expect(listsIniEntry(`Mods = ${MOD}\n`, "Mods", MOD)).toBe(true);
    expect(listsIniEntry(`Mods=A;${MOD}Extra\n`, "Mods", MOD)).toBe(false);
    expect(listsIniEntry("PVP=true\n", "WorkshopItems", ID)).toBe(false);
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

  it("writes the key back as `Key=`, a line the game reads", () => {
    expect(insertIniListEntry("WorkshopItems = 1;2\n", "WorkshopItems", ID, 1)).toBe(`WorkshopItems=1;${ID};2\n`);
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
