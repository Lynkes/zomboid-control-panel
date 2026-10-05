// The one reader/editor for <server>_SandboxVars.lua. Every route and service
// that reads or writes the file goes through here (#197).
//
// The writers used to be per-caller regexes. They had no idea which table a
// line belonged to, and a value pattern that also matched "{". A mod table
// "Explosives = { ... }" next to a numeric "Explosives = 1.0" inside another
// table was read as one top-level setting, and the next structured save wrote
// "Explosives = 1" over the table's opening line. The game then refused to
// load the file.
//
// This module tokenizes the file the way the game's Lua loader (Kahlua, Lua
// 5.1 lexing rules) does, maps every assignment to its path
// (SandboxVars > [Block >] Key) with the exact source span of its value, and
// edits by path. Behaviour checked against game build 42.21's own loader
// (zombie.Lua.LuaManager.RunLua on probe files):
//   - duplicate keys and duplicate "SandboxVars = ..." statements: last wins;
//   - a leading UTF-8 byte-order mark is a load error;
//   - "\ddd", "\[" and unknown escapes ("\q" is "q", "\x41" is "x41");
//   - long strings and --[[ ]] comments with any "=" level;
//   - "0x1F" but not "0X1F"; "1e400" is infinity, but "-1e400" stops the load;
//   - one optional ";" after a statement, never an empty statement;
//   - "1 + 1" style expressions load, but this module refuses to parse them
//     rather than guess (the game never writes them).
//
// Edits replace only the value's own source span. Everything else stays
// byte-for-byte: comments, layout, line endings. A table is never replaced by
// a scalar or the reverse; those edits are refused and reported. An edit whose
// result would not parse is refused too, so no caller can write a file the
// game would reject.

const RESERVED_WORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
  "until", "while",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Kahlua stack depth is far beyond anything a real file uses; this only stops
// a pathological "{{{{..." from blowing the JS stack.
const MAX_TABLE_DEPTH = 200;

export function isLuaIdentifier(name) {
  return typeof name === "string" && IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

export class SandboxLuaSyntaxError extends Error {
  constructor(message, src, offset) {
    const { line, column } = positionOf(src, offset);
    super(`line ${line}: ${message}`);
    this.name = "SandboxLuaSyntaxError";
    this.line = line;
    this.column = column;
    this.detail = message;
  }
}

function positionOf(src, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    const c = src[i];
    if (c === "\n" || c === "\r") {
      // \r\n and \n\r count as one line break, as in Lua's inclinenumber().
      const pair = src[i + 1];
      if ((pair === "\n" || pair === "\r") && pair !== c) i++;
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

// ---- Lexer -------------------------------------------------------------------

const isDigit = (c) => c >= "0" && c <= "9";
const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);
const isNewline = (c) => c === "\n" || c === "\r";

// At src[i] === "[": the level of a long bracket opener ("[[" = 0, "[==[" = 2),
// -1 for a plain "[", or -2 for "[=" with no second "[".
function longBracketLevel(src, i) {
  let j = i + 1;
  while (src[j] === "=") j++;
  if (src[j] === "[") return j - i - 1;
  return j === i + 1 ? -1 : -2;
}

// Skip one line break (\n, \r, \r\n or \n\r) at src[i]; returns the new index.
function skipNewline(src, i) {
  const c = src[i];
  const next = src[i + 1];
  return isNewline(next) && next !== c ? i + 2 : i + 1;
}

function readLongBracket(src, start, level, what) {
  const close = "]" + "=".repeat(level) + "]";
  let i = start + level + 2;
  // A newline right after the opener is not part of the string.
  if (isNewline(src[i])) i = skipNewline(src, i);
  const end = src.indexOf(close, i);
  if (end === -1) {
    throw new SandboxLuaSyntaxError(`unfinished long ${what}`, src, start);
  }
  // Lua stores every line break inside a long string as "\n".
  const value = src.slice(i, end).replace(/\r\n|\n\r|\r/g, "\n");
  return { end: end + close.length, value };
}

const SIMPLE_ESCAPES = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

function readShortString(src, start) {
  const quote = src[start];
  let i = start + 1;
  let value = "";
  for (;;) {
    const c = src[i];
    if (c === undefined || isNewline(c)) {
      throw new SandboxLuaSyntaxError("unfinished string", src, start);
    }
    if (c === quote) return { end: i + 1, value };
    if (c !== "\\") {
      value += c;
      i++;
      continue;
    }
    const e = src[i + 1];
    if (e === undefined) throw new SandboxLuaSyntaxError("unfinished string", src, start);
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)) {
      value += SIMPLE_ESCAPES[e];
      i += 2;
    } else if (isNewline(e)) {
      value += "\n";
      i = skipNewline(src, i + 1);
    } else if (isDigit(e)) {
      let j = i + 1;
      let digits = "";
      while (digits.length < 3 && isDigit(src[j])) digits += src[j++];
      const code = Number(digits);
      if (code > 255) throw new SandboxLuaSyntaxError("escape sequence too large", src, i);
      value += String.fromCharCode(code);
      i = j;
    } else {
      // \\ \" \' and every unknown escape: the character itself.
      value += e;
      i += 2;
    }
  }
}

const MAX_HEX_NUMBER = 0x7fffffffffffffffn;

function readNumber(src, start) {
  let i = start;
  while (isDigit(src[i]) || src[i] === ".") i++;
  if (src[i] === "e" || src[i] === "E") {
    i++;
    if (src[i] === "+" || src[i] === "-") i++;
  }
  while (src[i] !== undefined && isIdentPart(src[i])) i++;
  const text = src.slice(start, i);
  let value;
  // The game reads "0x..." with Long.parseLong (lowercase "x" only, at most
  // 0x7fffffffffffffff) and anything else with Double.parseDouble, where
  // "1e400" is infinity rather than an error.
  if (/^0x[0-9a-fA-F]+$/.test(text) && BigInt(text) <= MAX_HEX_NUMBER) value = Number(BigInt(text));
  else if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) value = Number(text);
  else throw new SandboxLuaSyntaxError(`malformed number near '${text}'`, src, start);
  return { end: i, value };
}

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) {
    throw new SandboxLuaSyntaxError(
      "the file starts with a byte-order mark, which the game's Lua loader rejects",
      src,
      0,
    );
  }
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      i += 2;
      if (src[i] === "[") {
        const level = longBracketLevel(src, i);
        if (level >= 0) {
          i = readLongBracket(src, i, level, "comment").end;
          continue;
        }
      }
      while (i < n && !isNewline(src[i])) i++;
      continue;
    }
    const start = i;
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(src[i])) i++;
      tokens.push({ type: "name", value: src.slice(start, i), start, end: i });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const { end, value } = readNumber(src, start);
      tokens.push({ type: "number", value, start, end });
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const { end, value } = readShortString(src, start);
      tokens.push({ type: "string", value, quote: c, start, end });
      i = end;
      continue;
    }
    if (c === "[") {
      const level = longBracketLevel(src, i);
      if (level >= 0) {
        const { end, value } = readLongBracket(src, start, level, "string");
        tokens.push({ type: "string", value, quote: "[", start, end });
        i = end;
        continue;
      }
      if (level === -2) throw new SandboxLuaSyntaxError("invalid long string delimiter", src, start);
    }
    if ("{}[]=,;-".includes(c)) {
      tokens.push({ type: c, start, end: i + 1 });
      i++;
      continue;
    }
    // Operators, parentheses and anything else: valid Lua in places, but not
    // something a SandboxVars file is made of. The parser reports it.
    tokens.push({ type: "other", value: c, start, end: i + 1 });
    i++;
  }
  tokens.push({ type: "eof", start: n, end: n });
  return tokens;
}

// ---- Parser ------------------------------------------------------------------
//
// chunk  := { Name '=' value [';'] }
// value  := table | string | number | '-'... number | true | false | nil
// table  := '{' [ field { (','|';') field } [','|';'] ] '}'
// field  := Name '=' value | '[' value ']' '=' value | value

function describeToken(src, t) {
  if (t.type === "eof") return "<eof>";
  return src.slice(t.start, Math.min(t.end, t.start + 40));
}

function parseTokens(src, tokens) {
  let p = 0;
  const peek = (k = 0) => tokens[Math.min(p + k, tokens.length - 1)];
  const next = () => tokens[p++];
  const fail = (message, t = peek()) => {
    throw new SandboxLuaSyntaxError(message, src, t.start);
  };

  function parseValue(depth) {
    const t = peek();
    if (t.type === "{") return parseTable(depth + 1);
    if (t.type === "string") {
      next();
      return { kind: "string", value: t.value, quote: t.quote, start: t.start, end: t.end };
    }
    if (t.type === "number") {
      next();
      return { kind: "number", value: t.value, start: t.start, end: t.end };
    }
    if (t.type === "-") {
      let sign = 1;
      while (peek().type === "-") {
        next();
        sign = -sign;
      }
      const num = peek();
      if (num.type !== "number") {
        fail(`unsupported expression near '${describeToken(src, num)}'`, num);
      }
      // The game's compiler leaves a minus on an infinite number to run time,
      // and game 42.21 stops loading the file there.
      if (!Number.isFinite(num.value)) {
        fail(`number out of range near '${src.slice(t.start, num.end)}'`, t);
      }
      next();
      return { kind: "number", value: sign * num.value, start: t.start, end: num.end };
    }
    if (t.type === "name" && (t.value === "true" || t.value === "false")) {
      next();
      return { kind: "boolean", value: t.value === "true", start: t.start, end: t.end };
    }
    if (t.type === "name" && t.value === "nil") {
      next();
      return { kind: "nil", value: null, start: t.start, end: t.end };
    }
    if (t.type === "name" || t.type === "other") {
      fail(`unsupported expression near '${describeToken(src, t)}'`, t);
    }
    return fail(`unexpected symbol near '${describeToken(src, t)}'`, t);
  }

  function parseTable(depth) {
    const open = next();
    if (depth > MAX_TABLE_DEPTH) fail("tables nested too deeply", open);
    const fields = [];
    // key -> the field the game ends up with (the last one), so a lookup
    // does not rescan a table that has thousands of keys.
    const last = new Map();
    const add = (field) => {
      fields.push(field);
      last.set(field.key, field);
    };
    for (;;) {
      const t = peek();
      if (t.type === "}") break;
      if (t.type === "[") {
        next();
        const keyNode = parseValue(depth);
        if (peek().type !== "]") fail(`']' expected near '${describeToken(src, peek())}'`);
        next();
        if (peek().type !== "=") fail(`'=' expected near '${describeToken(src, peek())}'`);
        next();
        const key =
          keyNode.kind === "string" || keyNode.kind === "number" || keyNode.kind === "boolean"
            ? keyNode.value
            : null;
        add({ key, keyStart: t.start, value: parseValue(depth) });
      } else if (t.type === "name" && peek(1).type === "=") {
        if (RESERVED_WORDS.has(t.value)) {
          fail(`'${t.value}' is a reserved word and cannot be used as a key`, t);
        }
        next();
        next();
        add({ key: t.value, keyStart: t.start, value: parseValue(depth) });
      } else {
        add({ key: null, keyStart: t.start, value: parseValue(depth) });
      }
      const sep = peek();
      if (sep.type === "," || sep.type === ";") {
        next();
        continue;
      }
      if (sep.type === "}") break;
      // Same wording as the game's own loader, so the panel's message matches
      // the line the server log shows.
      const { line } = positionOf(src, open.start);
      fail(`'}' expected (to close '{' at line ${line}) near '${describeToken(src, sep)}'`, sep);
    }
    const close = next();
    return { kind: "table", fields, last, start: open.start, end: close.end };
  }

  const statements = [];
  while (peek().type !== "eof") {
    const t = peek();
    if (t.type !== "name" || RESERVED_WORDS.has(t.value) || peek(1).type !== "=") {
      fail(`expected an assignment such as 'SandboxVars = { ... }' near '${describeToken(src, t)}'`, t);
    }
    next();
    next();
    statements.push({ name: t.value, value: parseValue(0) });
    // One optional ';' after a statement, as in Lua 5.1. An empty statement
    // (a leading ';' or ';;') is a syntax error in the game.
    if (peek().type === ";") next();
  }
  return statements;
}

// ---- Document ----------------------------------------------------------------

let lastParse = null;

/**
 * Parse SandboxVars.lua content. Returns `{ ok: true, root }` where `root` is
 * the table the game will read as SandboxVars (null when there is none), or
 * `{ ok: false, error: { message, line, column } }` when the file does not
 * parse. Documents are immutable, so the last result is reused when the same
 * content is parsed again (template preview reads one key at a time).
 */
export function parseSandboxLua(content) {
  if (lastParse && lastParse.content === content) return lastParse.doc;
  let doc;
  if (typeof content !== "string") {
    doc = { ok: false, error: { message: "SandboxVars content is not text", line: 1, column: 1 } };
  } else {
    try {
      const statements = parseTokens(content, tokenize(content));
      let root = null;
      for (const statement of statements) {
        if (statement.name === "SandboxVars") root = statement.value;
      }
      doc = { ok: true, root: root && root.kind === "table" ? root : null };
    } catch (error) {
      if (!(error instanceof SandboxLuaSyntaxError)) throw error;
      doc = {
        ok: false,
        error: { message: error.message, line: error.line, column: error.column },
      };
    }
  }
  lastParse = { content, doc };
  return doc;
}

// The entry the game ends up with for `key`: the last one wins.
function lastField(table, key) {
  return table.last.get(key);
}

/**
 * The value node at `path` (["Key"] for a top-level key, ["Block", "Key"] for
 * a key inside a block), or undefined. `kind` is "table", "string", "number",
 * "boolean" or "nil".
 */
export function resolveSandboxPath(doc, path) {
  let node = doc && doc.ok ? doc.root : null;
  for (const segment of path) {
    if (!node || node.kind !== "table") return undefined;
    const field = lastField(node, segment);
    if (!field) return undefined;
    node = field.value;
  }
  return node || undefined;
}

/** The scalar value at `path`, or undefined when absent, a table, or unparseable. */
export function readSandboxPath(content, path) {
  const node = resolveSandboxPath(parseSandboxLua(content), path);
  if (!node || node.kind === "table" || node.kind === "nil") return undefined;
  return node.value;
}

// ---- Formatting --------------------------------------------------------------

/** Escape a string for a quoted Lua string literal. */
export function escapeLuaString(str) {
  return String(str).replace(/[\\"'\n\r\t\0[\]]/g, (c) => {
    const escapes = {
      "\\": "\\\\",
      '"': '\\"',
      "'": "\\'",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      // Three digits, so a digit that follows is not read as part of it.
      "\0": "\\000",
      "[": "\\[",
      "]": "\\]",
    };
    return escapes[c];
  });
}

function isWritableScalar(value) {
  return (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

// `node` is the value being replaced. Its number style is kept: an integer
// written over "1.0" is "2.0", not "2". A string keeps its quote character.
function formatScalar(value, node, src) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    const original = node.kind === "number" ? src.slice(node.start, node.end) : "";
    if (Number.isInteger(value) && original.includes(".")) return value.toFixed(1);
    return String(value);
  }
  const quote = node.kind === "string" && node.quote === "'" ? "'" : '"';
  return `${quote}${escapeLuaString(value)}${quote}`;
}

function sameScalar(node, value) {
  if (node.kind === "nil" || node.kind === "table") return false;
  return typeof node.value === typeof value && node.value === value;
}

// ---- Editing -----------------------------------------------------------------

/**
 * Apply `edits` ([{ path, value }]) to SandboxVars.lua content. Only keys
 * already in the file are changed; nothing is appended. Each result's status:
 *   "changed"       value rewritten in place
 *   "unchanged"     the file already holds this value; no bytes touched
 *   "not-found"     no entry at that path
 *   "table"         the entry is a table; refusing to overwrite it with a value
 *   "invalid-value" the new value is not a boolean, finite number or string
 *   "invalid-path"  a path segment is not a Lua identifier
 * When the content does not parse, returns `{ ok: false, error }` and the
 * content unchanged.
 */
export function editSandboxValues(content, edits) {
  const doc = parseSandboxLua(content);
  if (!doc.ok) return { ok: false, error: doc.error, content, results: [] };

  // The last edit for a path wins, as it would if they ran one after another.
  const byPath = new Map();
  for (const edit of edits) byPath.set(JSON.stringify(edit.path), edit);

  const replacements = [];
  const statusByPath = new Map();
  for (const [pathKey, { path, value }] of byPath) {
    let status;
    if (!Array.isArray(path) || path.length === 0 || !path.every(isLuaIdentifier)) {
      status = "invalid-path";
    } else {
      const node = resolveSandboxPath(doc, path);
      if (!node) status = "not-found";
      else if (node.kind === "table") status = "table";
      else if (!isWritableScalar(value)) status = "invalid-value";
      else if (sameScalar(node, value)) status = "unchanged";
      else {
        replacements.push({ start: node.start, end: node.end, text: formatScalar(value, node, content) });
        status = "changed";
      }
    }
    statusByPath.set(pathKey, status);
  }

  // Spans never overlap: each is one scalar literal.
  const pieces = [];
  let at = 0;
  for (const r of replacements.sort((a, b) => a.start - b.start)) {
    pieces.push(content.slice(at, r.start), r.text);
    at = r.end;
  }
  pieces.push(content.slice(at));
  const next = pieces.join("");

  const results = edits.map((edit) => ({
    path: edit.path,
    status: statusByPath.get(JSON.stringify(edit.path)),
  }));

  if (replacements.length > 0) {
    // Belt and braces: a replacement is a single literal in a value position,
    // so this should never fire. If it ever does, nothing gets written.
    const check = parseSandboxLua(next);
    const lost = check.ok
      ? results.find(
          (r) =>
            r.status === "changed" &&
            !sameScalar(resolveSandboxPath(check, r.path) || { kind: "nil" }, byPath.get(JSON.stringify(r.path)).value),
        )
      : null;
    if (!check.ok || lost) {
      return {
        ok: false,
        error: {
          message: check.ok
            ? `edit to ${lost.path.join(".")} did not read back`
            : `edit would produce invalid Lua (${check.error.message})`,
          line: check.ok ? 1 : check.error.line,
          column: check.ok ? 1 : check.error.column,
        },
        content,
        results: [],
      };
    }
  }
  return { ok: true, content: next, results };
}

// ---- Sections (the Server Config page's shape) -------------------------------

// Every vanilla block the Server Config page expects, present even when empty.
export const SANDBOX_KNOWN_SECTIONS = [
  "ZombieLore",
  "ZombieConfig",
  "MultiplierConfig",
  "Map",
  "Basement",
  "Music",
  "Debug",
];

// Names that would clash with the result's own shape or with Object.prototype.
const RESERVED_SECTION_NAMES = new Set(["settings", "VERSION", "__proto__", "constructor", "prototype"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function scalarEntries(table) {
  const out = {};
  for (const field of table.fields) {
    if (typeof field.key !== "string" || !isLuaIdentifier(field.key) || UNSAFE_KEYS.has(field.key)) continue;
    // Recompute from the last occurrence so a later duplicate (even a table
    // or nil) decides what the key is, the same way the game sees it.
    const value = lastField(table, field.key).value;
    if (value.kind === "table" || value.kind === "nil") delete out[field.key];
    else out[field.key] = value.value;
  }
  return out;
}

/**
 * The Server Config page's view of the file:
 *   { VERSION, settings: { top-level values }, <Block>: { values }, ... }
 * Every top-level table is its own section under its real name (vanilla
 * blocks and mod blocks alike), so a key is never reported as top-level when
 * it lives in a table. Tables nested inside a block are not sandbox options
 * (the game only reads one level) and are left out. `error` is set, and the
 * sections are empty, when the file does not parse.
 */
export function sandboxSectionsFromLua(content) {
  const sandbox = { VERSION: 4, settings: {} };
  for (const name of SANDBOX_KNOWN_SECTIONS) sandbox[name] = {};
  const doc = parseSandboxLua(content);
  if (!doc.ok) return { sandbox, error: doc.error };
  if (!doc.root) return { sandbox, error: null };

  const seen = new Set();
  for (const field of doc.root.fields) {
    const key = field.key;
    if (typeof key !== "string" || !isLuaIdentifier(key) || seen.has(key)) continue;
    seen.add(key);
    const value = lastField(doc.root, key).value;
    if (key === "VERSION") {
      if (value.kind === "number") sandbox.VERSION = Math.trunc(value.value);
    } else if (value.kind === "table") {
      if (!RESERVED_SECTION_NAMES.has(key)) sandbox[key] = scalarEntries(value);
    } else if (value.kind !== "nil" && !UNSAFE_KEYS.has(key)) {
      sandbox.settings[key] = value.value;
    }
  }
  return { sandbox, error: null };
}

/**
 * Turn the page's section shape back into edits. "settings" keys are
 * top-level; every other section is the block of the same name. VERSION is
 * the game's file-format marker and is never written from here, whether it
 * comes as the page's own VERSION or as settings.VERSION.
 */
export function sectionsToEdits(sections) {
  const edits = [];
  for (const [section, values] of Object.entries(sections || {})) {
    if (section === "VERSION" || !values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (section === "settings" && key === "VERSION") continue;
      edits.push({ section, key, path: section === "settings" ? [key] : [section, key], value });
    }
  }
  return edits;
}

// ---- Validation --------------------------------------------------------------

/**
 * Count structural braces, skipping strings and comments. Lenient on purpose:
 * it still gives a count for a file that does not parse (that is when it is
 * needed), treating an unfinished string as ending at its line. A file that
 * parses has every brace matched, so the parser answers for it.
 */
export function countSandboxBraces(content) {
  if (parseSandboxLua(content).ok) return { balanced: true, depth: 0 };
  const src = String(content);
  let depth = 0;
  let wentNegative = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") {
      i += 2;
      const level = src[i] === "[" ? longBracketLevel(src, i) : -1;
      if (level >= 0) {
        const end = src.indexOf("]" + "=".repeat(level) + "]", i + level + 2);
        i = end === -1 ? src.length : end + level + 2;
      } else {
        while (i < src.length && !isNewline(src[i])) i++;
      }
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && !isNewline(src[i])) {
        if (src[i] !== "\\") {
          i++;
        } else if (isNewline(src[i + 1])) {
          // Backslash-newline continues the string; "\r\n" and "\n\r" are one
          // line break, as in readShortString().
          i = skipNewline(src, i + 1);
        } else {
          i += 2;
        }
      }
      i++;
    } else if (c === "[" && longBracketLevel(src, i) >= 0) {
      const level = longBracketLevel(src, i);
      const end = src.indexOf("]" + "=".repeat(level) + "]", i + level + 2);
      i = end === -1 ? src.length : end + level + 2;
    } else {
      if (c === "{") depth++;
      else if (c === "}" && --depth < 0) wentNegative = true;
      i++;
    }
  }
  return { balanced: depth === 0 && !wentNegative, depth };
}

/**
 * Whether the game can load this content. `parses` is a clean tokenize and
 * parse (the bar for writing anything); `valid` also needs a SandboxVars
 * table; `balanced`/`depth` are the structural brace count.
 */
export function validateSandboxLua(content) {
  const braces = countSandboxBraces(content);
  const doc = parseSandboxLua(content);
  const parses = doc.ok && braces.balanced;
  let error = doc.ok ? null : doc.error;
  if (!error && !doc.root) {
    error = { message: "no 'SandboxVars = { ... }' table found", line: 1, column: 1 };
  }
  return { valid: parses && !error, parses, ...braces, error };
}
