// What the mod conflict scanner (routes/mods.js) reads out of the files two
// mods both ship: translation keys, script definitions, clothing items and
// Lua symbols. Each returns a Set, or null when the file could not be read or
// is too large to parse (null fails closed: the pair stays a conflict).
//
// Security audit 2026-10-20: these run on files from any Workshop mod, and
// several of the regexes they used backtracked super-linearly on hostile
// input: "<m_MaleModel>" and 6 KB of spaces took 52 s (cubic), 100 KB of
// blank lines in a .lua 21 s, all on the panel's one thread. Every file is
// now size-capped before it is read, no pattern lets a run of whitespace be
// rescanned from every line start, and Lua block comments are stripped by a
// linear scan. On ordinary files the results are exactly what the old
// patterns gave (server/tests/modDefinitionExtractors.test.js).
import fs from "fs";
import { stripBom } from "./modIni.js";
import { createLogger } from "./logger.js";

const log = createLogger("API:Mods");

// The size each extractor parses, in characters (the old checks' unit).
export const MAX_DEFINITION_FILE_CHARS = 2 * 1024 * 1024;
// A UTF-8 character is at most 4 bytes: a file larger than this can't fit
// the character cap, so it is refused before being read at all.
const MAX_DEFINITION_FILE_BYTES = 4 * MAX_DEFINITION_FILE_CHARS;

// Whitespace that does not end a line (for `^` in multiline mode, a line
// ends at \n, \r, U+2028 and U+2029). Used where the old patterns had a
// leading `\s*` that let one match start on any earlier blank line.
const INLINE_WS = "[^\\S\\n\\r\\u2028\\u2029]*";

/** The file's text without a BOM, or null when it is over the cap. */
function readCappedText(filePath) {
  if (fs.statSync(filePath).size > MAX_DEFINITION_FILE_BYTES) return null;
  const content = stripBom(fs.readFileSync(filePath, "utf-8"));
  return content.length > MAX_DEFINITION_FILE_CHARS ? null : content;
}

// ─── Translation file key extraction ────────────────────────────────────────
// PZ translation files are Lua tables with `KEY = "value"` entries.
// Multiple mods can each add their own keys to the same file name — only
// overlapping keys represent a real conflict.
const TRANSLATION_KEY_RE = new RegExp(`^${INLINE_WS}([A-Za-z_]\\w*)\\s*=\\s*(?:"|'|\\[\\[)`, "gm");

export function extractTranslationKeys(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null;
    const keys = new Set();
    // Match lines like:   IGUI_perks_Lightfoot = "靈巧",
    // The value must look like a string ("..." or '...' or [[...]]).
    // This skips the wrapping table declaration `IGUI_EN = {` (false-positive
    // source: every translation file has one and the names sometimes match).
    const re = new RegExp(TRANSLATION_KEY_RE);
    let m;
    while ((m = re.exec(content)) !== null) keys.add(m[1]);
    return keys;
  } catch (e) {
    log.debug(`Error parsing translation file ${filePath}: ${e.message}`);
    return null;
  }
}

// ─── PZ script file parsing ─────────────────────────────────────────────────
// PZ script files (scripts/*.txt) contain blocks like:
//   module Base { item BaseballBat { ... } recipe CraftBat { ... } }
// PZ loads ALL .txt files from every mod's scripts/ folder and merges them.
// Two mods with the same filename but DIFFERENT module.type.name definitions
// are additive (not conflicting). Only overlapping definitions are real conflicts.
// B41 + B42 keywords (B42 adds craftRecipe, entity, xuiSkin, componentTemplate,
// bodyLocation, wallpaper, material, etc.).
const SCRIPT_DEF_RE = new RegExp(
  `^${INLINE_WS}(item|recipe|craftrecipe|vehicle|fixing|model|sound|animation|mannequin|evolvedrecipe|uniquerecipe|multistagebuild|entity|xuiskin|componenttemplate|bodylocation|wallpaper|material|template|electrical|liquid|liquidvacuumdef|stash|profession|trait|bodypart)\\s+(\\S+)`,
  "gim",
);
// Module bodies are scanned once each; only modules opened inside another
// (never valid in a PZ script) scan text twice. Past this many times the
// file's length, the file is refused rather than parsed.
const SCRIPT_SCAN_BUDGET_FACTOR = 4;

// The index of the "}" closing each "{" (by position), from one pass.
function matchingBraces(content) {
  const close = new Map();
  const open = [];
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    if (ch === 123) open.push(i); // {
    else if (ch === 125 && open.length) close.set(open.pop(), i); // }
  }
  return close;
}

export function extractScriptDefinitions(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null; // skip huge files
    const defs = new Set();
    const closing = matchingBraces(content);
    let budget = SCRIPT_SCAN_BUDGET_FACTOR * content.length + 1024;
    // Match: module ModuleName { ... }
    const moduleRe = /module\s+(\w+)\s*\{/g;
    let moduleMatch;
    while ((moduleMatch = moduleRe.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      const moduleStart = moduleMatch.index + moduleMatch[0].length;
      // The module's closing brace; an unclosed module runs to the end of
      // the file, less its last character (what the old depth count did).
      const close = closing.get(moduleStart - 1);
      const moduleBody = content.slice(moduleStart, close !== undefined ? close : content.length - 1);
      budget -= moduleBody.length;
      if (budget < 0) return null;
      const defRe = new RegExp(SCRIPT_DEF_RE);
      let defMatch;
      while ((defMatch = defRe.exec(moduleBody)) !== null) {
        defs.add(`${moduleName}.${defMatch[1].toLowerCase()}.${defMatch[2]}`);
      }
    }
    return defs;
  } catch (e) {
    log.debug(`Error parsing script file ${filePath}: ${e.message}`);
    return null;
  }
}

// ─── Clothing XML parsing ───────────────────────────────────────────────────
// PZ clothing files (clothing/clothing.xml, clothing/clothingitems/*.xml) are
// additive: PZ loads all such files from every mod and merges by item name.
// Two mods defining the same clothing item ID is a real conflict; different IDs
// are harmless. PZ uses `m_MaleModel`/`m_FemaleModel` as the unique identifier.
// The text between the tags is taken whole and trimmed (the old
// `\s*([^<]+)\s*` gave the same value, cubically); an empty element is not a
// definition, a blank one is the empty name, as before.
export function extractClothingDefinitions(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null;
    const defs = new Set();
    // Match XML tags like <m_MaleModel>ItemName</m_MaleModel> or <m_FemaleModel>ItemName</m_FemaleModel>
    const modelRe = /<m_(?:Male|Female)Model>([^<]*)<\/m_(?:Male|Female)Model>/gi;
    let m;
    while ((m = modelRe.exec(content)) !== null) {
      if (m[1].length > 0) defs.add(m[1].trim().toLowerCase());
    }
    // Also match <m_Name> for clothingitems XML format
    const nameRe = /<m_Name>([^<]*)<\/m_Name>/gi;
    while ((m = nameRe.exec(content)) !== null) {
      if (m[1].length > 0) defs.add(m[1].trim().toLowerCase());
    }
    return defs;
  } catch (e) {
    log.debug(`Error parsing clothing file ${filePath}: ${e.message}`);
    return null;
  }
}

// ─── Lua symbol extraction ──────────────────────────────────────────────────
// PZ does NOT merge Lua files: when two mods ship the same lua/.../foo.lua,
// the last-loaded one wins outright and the loser is discarded entirely.
// We extract the *names* both files define so the UI can show what would clash
// vs what would merely be shadowed:
//   fn:Foo.bar          — function declarations  (function Foo:bar / Foo.bar / function bar)
//   event:OnPlayerMove  — Events.X.Add subscriptions
//   class:ISFoo         — ISClass:derive("ISFoo") declarations
//   tbl:Foo             — top-level table assigns (Foo = {...})

// Removes every --[[ ... ]] block comment, in one pass: exactly what
// `.replace(/--\[\[[\s\S]*?\]\]/g, "")` did (an opener with no "]]" after
// it is left as it is), without rescanning the rest of the file from every
// unclosed opener.
export function stripLuaBlockComments(text) {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = text.indexOf("--[[", pos);
    if (start === -1) break;
    const end = text.indexOf("]]", start + 4);
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + 2;
  }
  return out + text.slice(pos);
}

// A match may start at the beginning of the text or after a newline, then
// whitespace on that line only (the old `(?:^|\n)\s*` could start on any
// earlier blank line and reached the same names).
const LUA_LINE_START = `(?:^|\\n)[^\\S\\n]*`;
const LUA_FN_RE = new RegExp(`${LUA_LINE_START}(?:local\\s+)?function\\s+([A-Za-z_][\\w.:]*)\\s*\\(`, "g");
const LUA_ASSIGN_FN_RE = new RegExp(`${LUA_LINE_START}([A-Za-z_][\\w.]*)\\s*=\\s*function\\s*\\(`, "g");
const LUA_CLASS_RE = new RegExp(`${LUA_LINE_START}([A-Z][\\w]*)\\s*=\\s*[A-Z][\\w]*\\s*:\\s*derive\\s*\\(`, "g");

export function extractLuaSymbols(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null;
    // Strip --[[ block comments ]] and -- line comments to avoid false positives
    const stripped = stripLuaBlockComments(content).replace(/--[^\n]*/g, "");
    const symbols = new Set();
    let m;
    // function Foo:bar(...)  |  function Foo.bar.baz(...)  |  function bar(...)
    const fnRe = new RegExp(LUA_FN_RE);
    while ((m = fnRe.exec(stripped)) !== null) symbols.add(`fn:${m[1]}`);
    // X.Y = function(...)
    const assignFnRe = new RegExp(LUA_ASSIGN_FN_RE);
    while ((m = assignFnRe.exec(stripped)) !== null) symbols.add(`fn:${m[1]}`);
    // Events.OnPlayerMove.Add(...)  /  .Remove(...)
    const evRe = /\bEvents\.([A-Za-z_]\w*)\.(?:Add|Remove)\s*\(/g;
    while ((m = evRe.exec(stripped)) !== null) symbols.add(`event:${m[1]}`);
    // ISFoo = ISBar:derive("ISFoo")  — class declarations
    const classRe = new RegExp(LUA_CLASS_RE);
    while ((m = classRe.exec(stripped)) !== null) symbols.add(`class:${m[1]}`);
    return symbols;
  } catch (e) {
    log.debug(`Error parsing Lua file ${filePath}: ${e.message}`);
    return null;
  }
}
