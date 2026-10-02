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

  it("reads the same keys as parseIni(), so the form and the other readers agree on what the file has", () => {
    expect(Object.keys(parseIniAsGame(content).values).sort()).toEqual(Object.keys(parseIni(content)).sort());
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
