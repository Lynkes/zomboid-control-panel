import { describe, it, expect } from "vitest";
import { editSandboxValues, readSandboxPath } from "../utils/sandboxLua.js";

// Every string the editor writes has to read back as the same string, or each
// save re-escapes what the last one escaped (seen in the wild:
// StreetlightGen.ExcludeSprites grew to 16k backslashes). Since #197 the
// write and the read are utils/sandboxLua.js's editor and Lua tokenizer, so
// this goes through both rather than a pair of string helpers.
const file = (literal) => `SandboxVars = {\n    Mod = {\n        List = ${literal},\n    },\n}\n`;
const PATH = ["Mod", "List"];

function save(content, value) {
  const result = editSandboxValues(content, [{ path: PATH, value }]);
  expect(result.ok).toBe(true);
  return result.content;
}

describe("SandboxVars Lua string round trip", () => {
  const values = [
    "",
    "plain text",
    "a\\b",
    "\\",
    "\\\\",
    "C:\\Users\\zomboid",
    'has "quotes" inside',
    "it's single-quoted",
    "comma,separated,list",
    "bracket[0]",
    "]]",
    "line\nbreak\ttab",
    "cr\r\nlf",
    `nul${String.fromCharCode(0)}12`,
    "{ } -- = ,",
    "location_sewer_01_32,location_sewer_01_33",
  ];

  it.each(values)("survives one write/read cycle: %j", (value) => {
    expect(readSandboxPath(save(file('"x"'), value), PATH)).toBe(value);
  });

  // The actual defect: each save re-escaped what the previous save escaped,
  // doubling every backslash until the file was unusable.
  it("stays byte-stable across 20 save cycles", () => {
    const original = "C:\\path\\to\\sprite,\\other";
    const first = save(file('"x"'), original);
    let onDisk = first;
    for (let i = 0; i < 20; i++) {
      onDisk = save(onDisk, readSandboxPath(onDisk, PATH));
    }
    expect(onDisk).toBe(first);
    expect(readSandboxPath(onDisk, PATH)).toBe(original);
  });

  it("does not grow a backslash-only value", () => {
    const first = file('"\\\\"');
    let onDisk = first;
    for (let i = 0; i < 10; i++) {
      onDisk = save(onDisk, readSandboxPath(onDisk, PATH));
    }
    expect(onDisk).toBe(first);
  });

  it("keeps a single-quoted literal single-quoted", () => {
    const written = save(file("'old'"), 'new "one"');
    expect(written).toContain(`List = 'new \\"one\\"',`);
    expect(readSandboxPath(written, PATH)).toBe('new "one"');
  });

  it("reads Lua escapes the way the game does", () => {
    // Checked against game build 42.21's loader: decimal escapes, "\[",
    // unknown escapes keep the character, no "\x" escapes in Lua 5.1.
    expect(readSandboxPath(file('"\\65\\066\\[\\q\\x41"'), PATH)).toBe("AB[qx41");
    expect(readSandboxPath(file("[==[a]]b\\n]==]"), PATH)).toBe("a]]b\\n");
  });
});
