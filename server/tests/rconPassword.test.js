import { describe, expect, it } from "vitest";
import {
  rconPasswordCannotBeStoredInIni,
  rconPasswordUnsupportedCharsBody,
} from "../utils/rconPassword.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { parseIniAsGame } from "../utils/iniGameView.js";

// What the game reads back from `RCONPassword=<text>` (zombie.config.
// ConfigFile.read, run from the 42.21 jar): the piece after the line's first
// "=" up to the next one, and a line ends at any line break. Everything else
// -- ";", "#", "$", quotes, backslashes, spaces -- comes back as written.

describe("rconPasswordCannotBeStoredInIni", () => {
  it.each([
    ["ab=cd"],
    ["="],
    ["trailing="],
    ["line\nbreak"],
    ["carriage\rreturn"],
    ["windows\r\nbreak"],
    ["Public=true"],
    // The game trims each ini line with Java's String.trim() (every char up
    // to U+0020) before it reads the value, so a blank at the very end is
    // lost: "RCONPassword=abc " reads back as "abc".
    ["abc "],
    ["abc\t"],
    ["abc  "],
    ["  spaces kept  "],
    [" "],
    ["abc" + String.fromCharCode(1)],
    ["abc" + String.fromCharCode(0x20)],
  ])("is true for %j", (password) => {
    expect(rconPasswordCannotBeStoredInIni(password)).toBe(true);
  });

  it.each([
    ["Pa$$w0rd"],
    ["a$&b"],
    ["semi;colon"],
    ["hash#tag"],
    ['quote"s and apostrophe\'s'],
    ["back\\slash"],
    ["  leading and inner  spaces kept"],
    ["\tleading tab"],
    ["ünïcødé-密码"],
    ["a".repeat(256)],
    // Java's trim() leaves these at the end of a line alone.
    ["abc" + String.fromCharCode(0xa0)],
    ["abc" + String.fromCharCode(0x7f)],
  ])("is false for %j, which the game reads back exactly", (password) => {
    expect(rconPasswordCannotBeStoredInIni(password)).toBe(false);
  });

  it("agrees with what the game reads back from the written line", () => {
    const candidates = [
      "abc",
      "abc ",
      "abc\t",
      " abc",
      "\tabc",
      "a b",
      "   ",
      "abc" + String.fromCharCode(1),
      "abc" + String.fromCharCode(0xa0),
      "abc" + String.fromCharCode(0x7f),
      "a;b#c",
    ];
    for (const password of candidates) {
      const read = parseIniAsGame(`PVP=false\nRCONPassword=${password}\nRCONPort=27015\n`).values.RCONPassword;
      // Never accepted when the game would read a different password back.
      if (read !== password) expect(rconPasswordCannotBeStoredInIni(password), JSON.stringify(password)).toBe(true);
      // And never refused when the game keeps it as it is.
      else expect(rconPasswordCannotBeStoredInIni(password), JSON.stringify(password)).toBe(false);
    }
  });

  it("has nothing to refuse for an absent or empty password", () => {
    expect(rconPasswordCannotBeStoredInIni(undefined)).toBe(false);
    expect(rconPasswordCannotBeStoredInIni(null)).toBe(false);
    expect(rconPasswordCannotBeStoredInIni("")).toBe(false);
  });

  it("judges the text a template literal would write, so a non-string body value can't smuggle a line break in", () => {
    expect(rconPasswordCannotBeStoredInIni(["a\nPublic=true"])).toBe(true);
    expect(rconPasswordCannotBeStoredInIni({ toString: () => "a=b" })).toBe(true);
    expect(rconPasswordCannotBeStoredInIni(12345)).toBe(false);
  });
});

describe("rconPasswordUnsupportedCharsBody", () => {
  it("is a 400 body with the translated code", () => {
    const body = rconPasswordUnsupportedCharsBody();
    expect(body.code).toBe(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS);
    expect(body.error).toMatch(/"="/);
    expect(body.error).toMatch(/line break/);
    expect(body.error).toMatch(/end with a space or tab/);
  });
});
