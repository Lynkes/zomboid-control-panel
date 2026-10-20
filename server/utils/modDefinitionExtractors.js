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
import crypto from "crypto";
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

// ─── Game-accurate readers (conflict rules, utils/modLoadOrder.js) ──────────
// The readers below give the conflict scanner what the game really merges:
// a translation's key -> value pairs, a script's definitions with a digest of
// each body, the global names a Lua file defines, clothing.xml's outfits.
// Same caps as above; every pattern is linear.

function digest(text) {
  return crypto.createHash("md5").update(text).digest("hex").slice(0, 16);
}

// Collapses whitespace runs so formatting alone never counts as a change.
function normaliseBody(text) {
  return text.replace(/\s+/g, " ").trim();
}

// B42 translations are JSON objects ({ "UI_Key": "text" }), read by the game
// with org.json's lenient parser. JSON.parse first; for a file it refuses,
// the "key": "value" pairs are read one by one.
const JSON_PAIR_RE = /"((?:[^"\\\n]|\\.)*)"[ \t]*:[ \t]*"((?:[^"\\\n]|\\.)*)"/g;

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * key -> value of a B42 translation file (Translate/<LANG>/<Category>.json),
 * or null when it cannot be read. Values are strings (numbers etc. as text);
 * nested objects are ignored.
 */
export function extractTranslationEntries(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null;
    const entries = new Map();
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || typeof value === "object") continue;
        entries.set(key, String(value));
      }
      return entries;
    }
    const re = new RegExp(JSON_PAIR_RE);
    let m;
    while ((m = re.exec(content)) !== null) {
      entries.set(unescapeJsonString(m[1]), unescapeJsonString(m[2]));
    }
    return entries.size > 0 || content.trim() === "" ? entries : null;
  } catch (e) {
    log.debug(`Error parsing translation file ${filePath}: ${e.message}`);
    return null;
  }
}

// Script block types of Build 42.21 (zombie.scripting.ScriptType tags), plus
// the B41 keywords the older reader knew. Compared case-insensitively.
const SCRIPT_TAGS = new Set(
  [
    "entityComponent", "vehicle", "entity", "item", "recipe", "uniquerecipe",
    "evolvedrecipe", "fixing", "animationsMesh", "mannequin", "model",
    "spriteModel", "sound", "soundTimeline", "animation", "vehicleEngineRPM",
    "itemConfig", "xuiLayout", "xuiStyle", "xuiDefaultStyle", "xuiGlobalColors",
    "xuiSkin", "xuiConfig", "itemFilter", "craftRecipe", "fluidFilter",
    "stringList", "energy", "fluid", "physicsShape", "timedAction", "ragdoll",
    "physicsHitReaction", "clock", "character_trait_definition",
    "character_profession_definition",
    "multistagebuild", "componenttemplate", "bodylocation", "wallpaper",
    "material", "electrical", "liquid", "liquidvacuumdef", "stash",
    "profession", "trait", "bodypart",
  ].map((t) => t.toLowerCase()),
);
// Types without the ResetExisting flag: a later body is applied on top of the
// earlier one instead of replacing it.
const MERGED_SCRIPT_TAGS = new Set(["vehicle", "xuiskin"]);

/** Removes every slash-star block comment in one pass. */
export function stripScriptBlockComments(text) {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = text.indexOf("/*", pos);
    if (start === -1) break;
    const end = text.indexOf("*/", start + 2);
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + 2;
  }
  return out + text.slice(pos);
}

/**
 * The definitions a PZ script file makes, as Map<"Module.type.Name",
 * { hash, merged }>: only blocks directly inside a module (the lines inside a
 * craftRecipe's inputs { item 1 [Base.Nails] } are not definitions), `hash`
 * a digest of the whitespace-normalised body, `merged` true for the types the
 * game layers instead of replacing (vehicle, xuiSkin). "template vehicle X" is
 * kept apart from "vehicle X". null when the file cannot be read.
 */
export function extractScriptDefinitionBodies(filePath) {
  try {
    const raw = readCappedText(filePath);
    if (raw === null) return null;
    const content = stripScriptBlockComments(raw);
    const defs = new Map();
    const closing = matchingBraces(content);
    const moduleRe = /module\s+(\w+)\s*\{/g;
    let moduleEnd = -1;
    let m;
    while ((m = moduleRe.exec(content)) !== null) {
      if (m.index < moduleEnd) continue; // a module opened inside another
      const moduleName = m[1];
      const bodyStart = m.index + m[0].length;
      const close = closing.get(bodyStart - 1);
      const bodyEnd = close !== undefined ? close : content.length;
      moduleEnd = bodyEnd;
      let pos = bodyStart;
      while (pos < bodyEnd) {
        const open = content.indexOf("{", pos);
        if (open === -1 || open >= bodyEnd) break;
        const blockClose = closing.get(open);
        const end = blockClose !== undefined && blockClose <= bodyEnd ? blockClose : bodyEnd;
        const header = content.slice(Math.max(pos, open - 400), open).trim();
        const tokens = header.split(/\s+/);
        const name = tokens[tokens.length - 1];
        const tag = (tokens[tokens.length - 2] || "").toLowerCase();
        if (tokens.length >= 2 && SCRIPT_TAGS.has(tag) && name && !/[{},]/.test(name)) {
          const template = (tokens[tokens.length - 3] || "").toLowerCase() === "template";
          const key = `${moduleName}.${template ? `template ${tag}` : tag}.${name}`;
          defs.set(key, {
            hash: digest(normaliseBody(content.slice(open + 1, end))),
            merged: !template && MERGED_SCRIPT_TAGS.has(tag),
          });
        }
        pos = end + 1;
      }
      moduleRe.lastIndex = Math.max(moduleRe.lastIndex, bodyEnd);
    }
    return defs;
  } catch (e) {
    log.debug(`Error parsing script file ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * The outfits of a clothing/clothing.xml, as Map<"male:Name" | "female:Name",
 * digest of the outfit>. The game merges these files outfit by outfit
 * (OutfitManager), a later outfit of the same name replacing the earlier.
 */
export function extractClothingOutfits(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null;
    const outfits = new Map();
    for (const gender of ["Male", "Female"]) {
      const openTag = `<m_${gender}Outfits>`;
      const closeTag = `</m_${gender}Outfits>`;
      let pos = 0;
      for (;;) {
        const start = content.indexOf(openTag, pos);
        if (start === -1) break;
        const end = content.indexOf(closeTag, start + openTag.length);
        if (end === -1) break;
        const body = content.slice(start + openTag.length, end);
        const nameStart = body.indexOf("<m_Name>");
        const nameEnd = nameStart === -1 ? -1 : body.indexOf("</m_Name>", nameStart);
        if (nameEnd !== -1) {
          const name = body.slice(nameStart + 8, nameEnd).trim();
          if (name) outfits.set(`${gender.toLowerCase()}:${name}`, digest(normaliseBody(body)));
        }
        pos = end + closeTag.length;
      }
    }
    return outfits;
  } catch (e) {
    log.debug(`Error parsing clothing file ${filePath}: ${e.message}`);
    return null;
  }
}

const LUA_LOCAL_NAMES_RE = /\blocal[ \t]+([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)/g;
const LUA_LOCAL_FUNCTION_RE = /\blocal[ \t]+function[ \t]+([A-Za-z_]\w*)/g;
const LUA_PARAMS_RE = /\bfunction\b[^(\n]{0,200}\(([^)\n]{0,400})\)/g;
const LUA_GLOBAL_FN_RE = new RegExp(`${LUA_LINE_START}function\\s+([A-Za-z_]\\w*(?:[.:][A-Za-z_]\\w*)*)\\s*\\(`, "g");
const LUA_GLOBAL_ASSIGN_FN_RE = new RegExp(`${LUA_LINE_START}([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s*=\\s*function\\s*\\(`, "g");
const LUA_GLOBAL_TABLE_RE = /(?:^|\n)([A-Za-z_]\w*)[ \t]*=[ \t]*\{/g;
const LUA_CAPTURE_RE = /=\s*([A-Za-z_]\w*(?:[ \t]*[.:][ \t]*[A-Za-z_]\w*)+)/g;

/**
 * The global names a Lua file (re)defines, which another mod's file defining
 * the same name would clobber:
 *   fn:Foo.bar   function Foo.bar / Foo:bar / Foo.bar = function (":" is ".")
 *   fn:bar       function bar / bar = function
 *   class:ISFoo  ISFoo = ISBase:derive(...)
 *   tbl:Foo      Foo = { ... } at the start of a line (resets the table)
 * Skipped: names whose first part is local in the file (local declarations,
 * local functions, function parameters, self) and functions the file keeps
 * the original of before replacing it (`local old = Foo.bar` -- a chained
 * hook, which coexists with others). Event subscriptions are additive and
 * never listed. null when the file cannot be read.
 */
export function extractLuaGlobals(filePath) {
  try {
    const content = readCappedText(filePath);
    if (content === null) return null;
    const stripped = stripLuaBlockComments(content).replace(/--[^\n]*/g, "");
    const locals = new Set(["self"]);
    let m;
    const localRe = new RegExp(LUA_LOCAL_NAMES_RE);
    while ((m = localRe.exec(stripped)) !== null) {
      for (const name of m[1].split(",")) locals.add(name.trim());
    }
    const localFnRe = new RegExp(LUA_LOCAL_FUNCTION_RE);
    while ((m = localFnRe.exec(stripped)) !== null) locals.add(m[1]);
    const paramsRe = new RegExp(LUA_PARAMS_RE);
    while ((m = paramsRe.exec(stripped)) !== null) {
      for (const name of m[1].split(",")) {
        const p = name.trim();
        if (/^[A-Za-z_]\w*$/.test(p)) locals.add(p);
      }
    }
    const captured = new Set();
    const captureRe = new RegExp(LUA_CAPTURE_RE);
    while ((m = captureRe.exec(stripped)) !== null) captured.add(m[1].replace(/[ \t]/g, "").replace(/:/g, "."));
    const globals = new Set();
    const addFn = (rawName) => {
      const name = rawName.replace(/:/g, ".");
      const root = name.split(".")[0];
      if (locals.has(root) || captured.has(name)) return;
      globals.add(`fn:${name}`);
    };
    const fnRe = new RegExp(LUA_GLOBAL_FN_RE);
    while ((m = fnRe.exec(stripped)) !== null) addFn(m[1]);
    const assignRe = new RegExp(LUA_GLOBAL_ASSIGN_FN_RE);
    while ((m = assignRe.exec(stripped)) !== null) addFn(m[1]);
    const classRe = new RegExp(LUA_CLASS_RE);
    while ((m = classRe.exec(stripped)) !== null) {
      if (!locals.has(m[1])) globals.add(`class:${m[1]}`);
    }
    const tableRe = new RegExp(LUA_GLOBAL_TABLE_RE);
    while ((m = tableRe.exec(stripped)) !== null) {
      if (!locals.has(m[1])) globals.add(`tbl:${m[1]}`);
    }
    return globals;
  } catch (e) {
    log.debug(`Error parsing Lua file ${filePath}: ${e.message}`);
    return null;
  }
}
