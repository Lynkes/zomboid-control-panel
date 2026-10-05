import { describe, expect, it } from "vitest";
import {
  countSandboxBraces,
  editSandboxValues,
  parseSandboxLua,
  readSandboxPath,
  sandboxSectionsFromLua,
  sectionsToEdits,
  validateSandboxLua,
} from "../utils/sandboxLua.js";

// utils/sandboxLua.js is the one SandboxVars.lua reader/editor (#197). The
// grammar cases below were run through game build 42.21's own loader
// (zombie.Lua.LuaManager.RunLua) first; each expectation is what the game
// did with the same text.

const wrap = (body) => `SandboxVars = {\n${body}\n}\n`;
const read = (body, path) => readSandboxPath(wrap(body), path);

describe("tokenizer agrees with the game's loader", () => {
  it.each([
    ["hex", "A = 0x10,", 16],
    ["exponent", "A = 1e2,", 100],
    ["negative exponent", "A = 2.5E-1,", 0.25],
    ["leading dot", "A = .5,", 0.5],
    ["trailing dot", "A = 5.,", 5],
    ["unary minus with a space", "A = - 4,", -4],
    ["double negation", "A = - -2,", 2],
    ["decimal escapes", 'A = "\\65\\066\\0067",', `AB${String.fromCharCode(6)}7`],
    ["unknown escape keeps the character", 'A = "q\\qz",', "qqz"],
    ['no "\\x" escape in Lua 5.1', 'A = "\\x41",', "x41"],
    ["backslash-newline", 'A = "a\\\nb",', "a\nb"],
    ["backslash-CRLF", 'A = "a\\\r\nb",', "a\nb"],
    ["backslash-LFCR", 'A = "a\\\n\rb",', "a\nb"],
    ["the largest hex number the game reads", "A = 0x7fffffffffffffff,", 2 ** 63],
    ["an exponent past the double range is infinity", "A = 1e400,", Infinity],
    ["long string skips its first newline", "A = [[\nfirst]],", "first"],
    ["long string with a level", "A = [==[x]]y]==],", "x]]y"],
    ["single quotes", "A = 'it\\'s',", "it's"],
    ["quoted key", '["A"] = 3,', 3],
    ["duplicate key, last wins", "A = 1, A = 2, [\"A\"] = 3,", 3],
    ["semicolon separators", "A = true; B = 1;", true],
    ["comment that is not a long bracket", "A = 1 --[ not long\n, B = 2", 1],
  ])("%s", (_label, body, expected) => {
    expect(read(body, ["A"])).toEqual(expected);
  });

  it("the last SandboxVars statement wins", () => {
    expect(readSandboxPath("SandboxVars = { A = 1 }\nSandboxVars = { A = 2 }\n", ["A"])).toBe(2);
  });

  it("accepts one ';' after each statement", () => {
    expect(readSandboxPath("X = 1; SandboxVars = { A = 2 };\n", ["A"])).toBe(2);
  });

  it.each([
    ["a leading ';'", ";SandboxVars = { A = 1 }\n"],
    ["two ';' after a statement", "SandboxVars = { A = 1 };;\n"],
    ["two ';' with a space between", "SandboxVars = { A = 1 } ; ; X = 1\n"],
  ])("rejects %s (an empty statement), as the game does", (_label, content) => {
    const doc = parseSandboxLua(content);
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toMatch(/near ';'/);
  });

  it("accepts a [nil] key without making it addressable", () => {
    expect(parseSandboxLua(wrap("[nil] = 1, A = 2,")).ok).toBe(true);
    expect(read("[nil] = 1, A = 2,", ["A"])).toBe(2);
  });

  it.each([
    ["the #197 corruption", "Explosives = 1\n    VanillaBallisticsEnabled = false,\n    },", /'}' expected \(to close '\{' at line 1\) near 'VanillaBallisticsEnabled'/],
    ["a missing comma", "A = 1 B = 2", /'}' expected/],
    ["an empty field", "A = 1,,", /unexpected symbol/],
    ["a leading separator", ", A = 1", /unexpected symbol/],
    ["a reserved word as a key", "local = 1", /reserved word/],
    ["a malformed number", "A = 1abc", /malformed number/],
    ["a hex float", "A = 0x1p4", /malformed number/],
    ["an uppercase hex prefix", "A = 0X1F", /malformed number near '0X1F'/],
    ["a hex number past Long.MAX_VALUE", "A = 0x8000000000000000", /malformed number/],
    ["a minus on an infinite number", "A = -1e400", /number out of range near '-1e400'/],
    ["a double minus on an infinite number", "A = - -1e400", /number out of range/],
    ["a newline inside a string", 'A = "line\nbreak"', /unfinished string/],
    ["an unfinished long comment", "--[[ never closed", /unfinished long comment/],
  ])("rejects %s, as the game does", (_label, body, message) => {
    const doc = parseSandboxLua(wrap(body));
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toMatch(message);
  });

  it("rejects a byte-order mark, as the game does", () => {
    const doc = parseSandboxLua(`${String.fromCharCode(0xfeff)}SandboxVars = { A = 1 }`);
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toMatch(/byte-order mark/);
  });

  // The game evaluates "1 + 1"; the editor refuses to guess and reports it.
  it("refuses expressions instead of guessing", () => {
    const doc = parseSandboxLua(wrap("A = 1 + 1,"));
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toMatch(/near '\+'/);
  });

  it("reports the line and column of an error", () => {
    const doc = parseSandboxLua("SandboxVars = {\r\n    A = 1,\r\n    B = ?,\r\n}\r\n");
    expect(doc.error).toEqual(expect.objectContaining({ line: 3, column: 9 }));
  });
});

describe("editSandboxValues", () => {
  const content = wrap(
    [
      "    Whole = 1,",
      "    Decimal = 1.0,",
      "    Negative = -1.0,",
      "    Text = 'single',",
      "    Flag = false,",
      "    Block = {",
      "        Inner = 2,",
      "    },",
    ].join("\n"),
  );
  const edit = (path, value) => editSandboxValues(content, [{ path, value }]);

  it.each([
    [["Whole"], 2, "Whole = 2,"],
    [["Whole"], 2.5, "Whole = 2.5,"],
    [["Decimal"], 3, "Decimal = 3.0,"],
    [["Decimal"], 0.25, "Decimal = 0.25,"],
    [["Negative"], -3, "Negative = -3.0,"],
    [["Negative"], 4, "Negative = 4.0,"],
    [["Text"], 'say "hi"', "Text = 'say \\\"hi\\\"',"],
    [["Flag"], true, "Flag = true,"],
    [["Block", "Inner"], 7, "Inner = 7,"],
  ])("writes %j = %j as %s and changes nothing else", (path, value, line) => {
    const result = edit(path, value);
    expect(result.results[0].status).toBe("changed");
    const before = content.split("\n");
    const after = result.content.split("\n");
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed.map((l) => l.trim())).toEqual([line]);
    expect(readSandboxPath(result.content, path)).toBe(value);
  });

  it("leaves the file untouched when the value already matches", () => {
    const result = edit(["Decimal"], 1);
    expect(result.results[0].status).toBe("unchanged");
    expect(result.content).toBe(content);
  });

  it.each([
    [["Block"], 1, "table"],
    [["Missing"], 1, "not-found"],
    [["Block", "Missing"], 1, "not-found"],
    [["Whole", "Inner"], 1, "not-found"],
    [["Whole"], { nested: 1 }, "invalid-value"],
    [["Whole"], Number.NaN, "invalid-value"],
    [["Whole"], null, "invalid-value"],
    [["local"], 1, "invalid-path"],
    [["Bad-Key"], 1, "invalid-path"],
  ])("refuses %j = %j (%s)", (path, value, status) => {
    const result = edit(path, value);
    expect(result.results[0].status).toBe(status);
    expect(result.content).toBe(content);
  });

  it("refuses to edit content that does not parse", () => {
    const broken = content.replace("    Block = {", "    Block = 1");
    const result = editSandboxValues(broken, [{ path: ["Whole"], value: 5 }]);
    expect(result.ok).toBe(false);
    expect(result.content).toBe(broken);
  });

  it("applies several edits at once, the last edit to a path winning", () => {
    const result = editSandboxValues(content, [
      { path: ["Whole"], value: 5 },
      { path: ["Block", "Inner"], value: 6 },
      { path: ["Whole"], value: 9 },
    ]);
    expect(readSandboxPath(result.content, ["Whole"])).toBe(9);
    expect(readSandboxPath(result.content, ["Block", "Inner"])).toBe(6);
  });

  it("writes only the last of duplicate entries, the one the game reads", () => {
    const dup = wrap("    A = 1,\n    A = 2,");
    const result = editSandboxValues(dup, [{ path: ["A"], value: 3 }]);
    expect(result.content).toBe(wrap("    A = 1,\n    A = 3,"));
  });
});

describe("sandboxSectionsFromLua", () => {
  it("keeps the page's shape: VERSION, settings and every vanilla block, even when empty", () => {
    const { sandbox, error } = sandboxSectionsFromLua("SandboxVars = { VERSION = 6, Zombies = 2 }");
    expect(error).toBeNull();
    expect(sandbox).toEqual({
      VERSION: 6,
      settings: { Zombies: 2 },
      ZombieLore: {},
      ZombieConfig: {},
      MultiplierConfig: {},
      Map: {},
      Basement: {},
      Music: {},
      Debug: {},
    });
  });

  it("does not let file keys collide with the shape or Object.prototype", () => {
    const { sandbox } = sandboxSectionsFromLua(
      'SandboxVars = { settings = { A = 1 }, ["__proto__"] = { polluted = true }, Mod = { ["constructor"] = 1, B = 2 } }',
    );
    expect(sandbox.settings).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(sandbox, "__proto__")).toBe(false);
    expect({}.polluted).toBeUndefined();
    expect(sandbox.Mod).toEqual({ B: 2 });
  });
});

describe("sectionsToEdits", () => {
  it("never writes VERSION, from the page's own field or from settings", () => {
    const content = "SandboxVars = {\n    VERSION = 6,\n    Zombies = 4,\n}\n";
    const edits = sectionsToEdits({ VERSION: 1, settings: { VERSION: 1, Zombies: 2 } });
    expect(edits.map((e) => e.path)).toEqual([["Zombies"]]);
    expect(editSandboxValues(content, edits).content).toBe(content.replace("Zombies = 4", "Zombies = 2"));
  });

  it("still writes a mod block's own VERSION key", () => {
    expect(sectionsToEdits({ SomeMod: { VERSION: 2 } }).map((e) => e.path)).toEqual([["SomeMod", "VERSION"]]);
  });
});

describe("validation", () => {
  it("counts only structural braces, even in a file that does not parse", () => {
    expect(countSandboxBraces('A = "{", B = [[}]] --[==[ { ]==] -- }\n{')).toEqual({ balanced: false, depth: 1 });
    expect(countSandboxBraces('A = "unfinished {\n}')).toEqual({ balanced: false, depth: -1 });
  });

  // "\" + CRLF continues a string in the game. The count used to skip only
  // the CR, end the string at the LF and misread the rest of that line.
  const continued = (eol, tail) =>
    ["SandboxVars = {", "    VERSION = 6,", '    A = "a\\', 'b", B = {', "        C = 1,", "    },", ...tail, "}", ""].join(eol);

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["LFCR", "\n\r"],
  ])("a string continued over a %s line break is one string", (_label, eol) => {
    const loads = continued(eol, ["    Zombies = 4,"]);
    expect(validateSandboxLua(loads)).toEqual(expect.objectContaining({ valid: true, balanced: true, depth: 0 }));
    // The #197 corruption below it: the count still has to be right.
    const broken = continued(eol, ["    Explosives = 1", "        Key = 2,", "    },"]);
    expect(countSandboxBraces(broken)).toEqual({ balanced: false, depth: -1 });
  });

  it("is valid only when the file parses and has a SandboxVars table", () => {
    expect(validateSandboxLua(wrap("A = '}'")).valid).toBe(true);
    expect(validateSandboxLua("Other = {}")).toEqual(
      expect.objectContaining({ valid: false, parses: true }),
    );
    expect(validateSandboxLua(wrap("A = 1 B = 2"))).toEqual(
      expect.objectContaining({ valid: false, balanced: true }),
    );
  });
});
