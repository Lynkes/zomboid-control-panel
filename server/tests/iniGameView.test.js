import { describe, expect, it, vi } from "vitest";
import {
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

  it("lists the keys whose line the game reads under another name, from the line parseIni() keeps", () => {
    expect(parseIniAsGame(content).misnamed).toEqual({
      Open: "Open ",
      PVP: "PVP ",
      Tabbed: "Tabbed\t",
      FirstKey: "\uFEFFFirstKey",
      Dup: "Dup ",
    });
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
