import { describe, expect, it, vi } from "vitest";
import {
  findIniFatalLines,
  iniValueChanges,
  javaTrim,
  parseIniAsGame,
  readIniLineAsGame,
} from "../utils/iniGameView.js";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getAllSettings: vi.fn(),
  getRoleByName: vi.fn(),
}));

const { parseIni } = await import("../routes/serverFiles.js");

// Each row: a server.ini line, then the option name and value 42.21's own
// zombie.config.ConfigFile.read produced for it (recorded by running it from
// projectzomboid.jar on the game's Java 25 runtime). The value the game hands
// to the option's parser ends at the next "="; readIniLineAsGame keeps the
// rest so the panel can write the line back unchanged.
const GAME_READS = [
  ["Public= true", "Public", " true"],
  ["Open =true", "Open ", "true"],
  [" PVP = false ", "PVP ", " false"],
  ["MaxPlayers= 16", "MaxPlayers", " 16"],
  ["PingLimit=\u00A0400", "PingLimit", "\u00A0400"],
  ["PauseEmpty=true\u00A0", "PauseEmpty", "true\u00A0"],
  ["PublicName= My Server", "PublicName", " My Server"],
  ["Empty=", "Empty", ""],
  ["\tTabbed\t=\tyes\t", "Tabbed\t", "\tyes"],
  ["Name=  two  spaces  ", "Name", "  two  spaces"],
  ["\uFEFFFirstKey=1", "\uFEFFFirstKey", "1"],
  ["Key=a=b", "Key", "a"],
  ["PublicDescription=Hello = world", "PublicDescription", "Hello "],
];

describe("readIniLineAsGame", () => {
  it.each(GAME_READS)("%j -> name %j, value %j", (line, name, gameValue) => {
    const { gameName, value } = readIniLineAsGame(line, line.indexOf("="));
    expect(gameName).toBe(name);
    expect(value.split("=")[0]).toBe(gameValue);
  });

  it("keeps the text after a second '=' so the line can be written back", () => {
    expect(readIniLineAsGame("Key=a = b ", 3).value).toBe("a = b");
  });
});

describe("parseIniAsGame", () => {
  const content = [
    "# comment=1",
    "; also=skipped",
    "=no key",
    "no equals sign",
    "",
    ...GAME_READS.map(([line]) => line),
    "Dup=first",
    "Dup = second",
    "Fixed = before",
    "Fixed=after",
  ].join("\r\n");

  it("reads the keys parseIni() reads, plus the ';' lines it skips, which the game reads as options", () => {
    // 42.21 reads "; also=skipped" as an option named "; also"; only a line
    // starting with "#" is a comment to it. No setting's name starts with ";".
    expect(Object.keys(parseIniAsGame(content).values).sort()).toEqual(
      [...Object.keys(parseIni(content)), "; also"].sort(),
    );
    expect(parseIniAsGame(content).values["; also"]).toBe("skipped");
  });

  it("gives each key the value text the game reads, untrimmed at the start", () => {
    const { values } = parseIniAsGame(content);
    expect(values).toMatchObject({
      Public: " true",
      MaxPlayers: " 16",
      PingLimit: "\u00A0400",
      PauseEmpty: "true\u00A0",
      Name: "  two  spaces",
      FirstKey: "1",
    });
    // parseIni() trims them all.
    expect(parseIni(content)).toMatchObject({ Public: "true", PingLimit: "400", PauseEmpty: "true" });
  });

  it("lists the keys whose line the game reads under another name, unless it reads another line for the key", () => {
    const { values, misnamed } = parseIniAsGame(content);
    expect(misnamed).toEqual({
      Open: "Open ",
      PVP: "PVP ",
      Tabbed: "Tabbed\t",
      FirstKey: "\uFEFFFirstKey",
    });
    expect(values).toMatchObject({ Dup: "first", Fixed: "after" });
  });

  // The game applies the lines it reads in order and skips a misnamed one:
  // 42.21's ConfigFile.read gives [PVP]->false and [PVP ]->" true" for the
  // first file, and only "PVP" is a ServerOptions name.
  it("a skipped line after one the game reads leaves that line's value", () => {
    expect(parseIniAsGame("PVP=false\nPVP = true\n")).toEqual({ values: { PVP: "false" }, misnamed: {} });
    expect(parseIniAsGame("PVP = true\nPVP=false\n")).toEqual({ values: { PVP: "false" }, misnamed: {} });
    expect(parseIniAsGame("PVP = true\nPVP  = false\n")).toEqual({
      values: { PVP: " false" },
      misnamed: { PVP: "PVP  " },
    });
  });

  it("ends a line at a lone CR, as the game's BufferedReader.readLine does", () => {
    // 42.21 reads "A=1\rB=2\nC=3" as A=1, B=2 and C=3.
    expect(parseIniAsGame("A=1\rB=2\nC=3\r\n").values).toEqual({ A: "1", B: "2", C: "3" });
  });

  // SECURITY (2026-10-20): each row is a line and what 42.21's
  // ConfigFile.read made of it (recorded on the game's Java 25 runtime):
  // Java's trim of the line removes control chars before the name and after
  // the value; the value's own start keeps them, as does the text between
  // the name and "=". JavaScript's trim() keeps control chars, so this view
  // used to list "\u0001RCONPassword" where the game read RCONPassword.
  const CONTROL_CHAR_READS = [
    ["\u0001RCONPassword=lead01", "RCONPassword", "lead01"],
    ["\u0000NulKey=nul", "NulKey", "nul"],
    ["\u000eSoKey=so", "SoKey", "so"],
    ["\u001fUsKey=\u001fus\u001f", "UsKey", "\u001fus"],
    ["DefaultPort=\u000116261", "DefaultPort", "\u000116261"],
    ["UDPPort=16262\u0001", "UDPPort", "16262"],
  ];

  it.each(CONTROL_CHAR_READS)("%j is read as %j = %j", (line, name, gameValue) => {
    expect(parseIniAsGame(`${line}\n`)).toEqual({ values: { [name]: gameValue }, misnamed: {} });
  });

  it("lists a control char after the name, or a no-break space before one, as misnamed", () => {
    // 42.21: [RCONPort\u0001]=x, and a name starting with the no-break space.
    expect(parseIniAsGame("RCONPort\u0001=x\n")).toEqual({
      values: { RCONPort: "x" },
      misnamed: { RCONPort: "RCONPort\u0001" },
    });
    expect(parseIniAsGame("\u00A0\u0001RCONPort=x\n").misnamed).toEqual({
      RCONPort: "\u00A0\u0001RCONPort",
    });
    // U+007F is not trimmed by either.
    expect(parseIniAsGame("\u007fDelKey=del\n").values).toEqual({ "\u007fDelKey": "del" });
  });

  it("skips only the lines the game skips: '#' after Java's trim", () => {
    // 42.21 skips "#Hash=1", " #SpaceHash=1" and "\u0001#CtrlHash=1", and
    // reads ";UPnP=x" as an option named ";UPnP".
    expect(parseIniAsGame("#Hash=1\n #SpaceHash=1\n\u0001#CtrlHash=1\n;UPnP=x\n").values).toEqual({
      ";UPnP": "x",
    });
    expect(parseIniAsGame("PVP=false\n;PVP=true\n").values).toEqual({ PVP: "false", ";PVP": "true" });
  });

  it("the last line the game reads for a key wins, whatever its control chars", () => {
    expect(parseIniAsGame("RCONPassword=a\n\u0001RCONPassword=b\n").values).toEqual({ RCONPassword: "b" });
    expect(parseIniAsGame("\u0002RCONPassword=a\nRCONPassword=b\n").values).toEqual({ RCONPassword: "b" });
  });
});

describe("findIniFatalLines", () => {
  // Whether 42.21's ConfigFile.read accepted each file, recorded by running
  // it from projectzomboid.jar on the game's Java 25 runtime. A rejected
  // file is ignored whole: the server runs on the default of every setting.
  it.each([
    ["Ok=1\n=\nAfter=2\n", [2]],
    ["Ok=1\n  = x\nAfter=2\n", [2]],
    ["Ok=1\n==\nAfter=2\n", [2]],
    ["Ok=1\nVersion=\nAfter=2\n", [2]],
    ["Ok=1\nVersion==\nAfter=2\n", [2]],
    ["Ok=1\nVersion=1\nAfter=2\n", []],
    ["Ok=1\nVersion= 1\nAfter=2\n", []],
    ["Ok=1\nversion=\nAfter=2\n", []],
    ["Ok=1\n#=x\nAfter=2\n", []],
    ["\uFEFF=x\nAfter=2\n", []],
    ["Ok=1\n\u00A0=x\nAfter=2\n", []],
    ["Ok=1\nno equals sign\n; =x\n", []],
  ])("%j -> %j", (content, expected) => {
    expect(findIniFatalLines(content)).toEqual(expected);
  });

  it("numbers lines as the game counts them, a lone CR ending one", () => {
    expect(findIniFatalLines("A=1\r=x\r\nB=2\n\t=\n")).toEqual([2, 4]);
  });
});

describe("iniValueChanges", () => {
  const view = parseIniAsGame("Public= true\nOpen =true\nEmpty=\n");

  it("is false only for the exact text the game already reads under that name", () => {
    expect(iniValueChanges(view, "Public", " true")).toBe(false);
    expect(iniValueChanges(view, "Public", "true")).toBe(true);
    expect(iniValueChanges(view, "Open", "true")).toBe(true);
    expect(iniValueChanges(view, "Empty", "")).toBe(false);
  });

  it("treats a missing key as changed only when the value is non-empty, as toIni() appends it", () => {
    expect(iniValueChanges(view, "Missing", "")).toBe(false);
    expect(iniValueChanges(view, "Missing", undefined)).toBe(false);
    expect(iniValueChanges(view, "Missing", "1")).toBe(true);
  });
});

describe("javaTrim", () => {
  it("removes chars up to U+0020 only", () => {
    expect(javaTrim("\u0001 \tx y\t\r")).toBe("x y");
    expect(javaTrim("\u00A0x\uFEFF")).toBe("\u00A0x\uFEFF");
  });
});
