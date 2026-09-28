/**
 * Pure text helpers for the three server.ini keys PanelBridge delivery
 * touches: Mods=, WorkshopItems= and DoLuaChecksum=. No fs here -- callers
 * (services/bridgeDelivery.js) own reading, locking, backing up and writing,
 * and hand these functions LF-normalized content.
 *
 * Every key match uses the same anchored `^[ \t]*Key[ \t]*=` shape as
 * iniKeyWrite.js and mods.js, so a key name that merely appears inside
 * another field's free text (PublicDescription, ServerWelcomeMessage) is
 * never read or rewritten. The one exception is getEffectiveChecksum(),
 * which answers what the GAME reads and so follows its stricter parser.
 *
 * List entries are compared the way the game compares them: split on `;`,
 * trimmed, empty entries dropped, and every backslash stripped (GameServer
 * removes `\` from Mods= before resolving ids, so `\ZomboidControlPanelBridge`
 * and `ZomboidControlPanelBridge` are the same mod). Entries this module
 * adds are written bare, the mods.js convention. Entries it does not own are
 * left byte-for-byte as they were, in their original order.
 */
import { escapeRegExp } from "./regex.js";

function keyLinePattern(key, flags = "m") {
  return new RegExp(`^([ \\t]*)${escapeRegExp(key)}([ \\t]*)=(.*)$`, flags);
}

// Adds a `key=value` line for a key the file doesn't have. Same intent as
// iniKeyWrite.setIniKeyLine()'s append branch, but a file that already ends
// in a newline gets the line appended after it (and keeps ending in one)
// instead of an empty line followed by an unterminated one.
function appendKeyLine(content, key, value) {
  const text = String(content ?? "");
  if (text === "") return `${key}=${value}\n`;
  return text.endsWith("\n") ? `${text}${key}=${value}\n` : `${text}\n${key}=${value}`;
}

function normalizeEntry(entry) {
  return String(entry).replace(/\\/g, "").trim();
}

// The raw, non-empty tokens of one list value, each paired with its
// normalized form. Raw tokens are kept so a rewrite never reformats an entry
// the panel doesn't own (a `\`-prefixed id stays `\`-prefixed).
function splitListValue(value) {
  return String(value)
    .split(";")
    .map((raw) => ({ raw: raw.trim(), id: normalizeEntry(raw) }))
    .filter((token) => token.id.length > 0);
}

// Reads the FIRST `key` line by default -- the line every panel writer
// (mods.js, the helpers below) edits. `{ last: true }` reads the line the
// game actually applies instead: ConfigFile.read keeps every line and
// ServerOptions.loadServerTextFile parses them in order, so with a
// duplicated key the last assignment wins. Identical for a file without
// duplicates.
export function parseIniList(content, key, { last = false } = {}) {
  const text = String(content ?? "");
  let match = null;
  if (last) {
    const pattern = keyLinePattern(key, "gm");
    for (let next = pattern.exec(text); next !== null; next = pattern.exec(text)) match = next;
  } else {
    match = keyLinePattern(key).exec(text);
  }
  if (!match) return { present: false, entries: [] };
  return { present: true, entries: splitListValue(match[3]).map((token) => token.id) };
}

export function hasBridgeEntries(content, modId, workshopId, options = {}) {
  const mods = parseIniList(content, "Mods", options).entries;
  const items = parseIniList(content, "WorkshopItems", options).entries;
  return {
    mods: mods.includes(modId),
    workshopItems: Boolean(workshopId) && items.includes(String(workshopId)),
  };
}

// Appends `value` to the first `key` line (the one mods.js edits too), or
// adds a `key=value` line when the key is missing entirely. A no-op when the
// entry is already listed. The game applies the LAST line of a duplicated
// key, so callers refuse to add entries to such a file at all (§6.7).
function addListEntry(content, key, value) {
  const pattern = keyLinePattern(key);
  const match = pattern.exec(content);
  if (!match) return appendKeyLine(content, key, value);
  const tokens = splitListValue(match[3]);
  if (tokens.some((token) => token.id === value)) return content;
  const existing = match[3].trim().replace(/;+$/, "").trim();
  const nextValue = existing ? `${existing};${value}` : value;
  return content.replace(pattern, () => `${match[1]}${key}${match[2]}=${nextValue}`);
}

export function addBridgeEntries(content, modId, workshopId) {
  let next = addListEntry(String(content ?? ""), "Mods", modId);
  if (workshopId) next = addListEntry(next, "WorkshopItems", String(workshopId));
  return next;
}

// Removes exact (normalized) matches of `values` from EVERY `key` line, not
// just the first: a removal is always safe to over-apply, and a duplicated
// key is exactly where a leftover entry would otherwise survive. Lines with
// nothing to remove are returned untouched.
export function removeIniListEntries(content, key, values) {
  const targets = new Set((values || []).filter(Boolean).map((value) => normalizeEntry(value)));
  if (targets.size === 0) return String(content ?? "");
  return String(content ?? "").replace(keyLinePattern(key, "gm"), (line, indent, spacing, value) => {
    const tokens = splitListValue(value);
    const kept = tokens.filter((token) => !targets.has(token.id));
    if (kept.length === tokens.length) return line;
    return `${indent}${key}${spacing}=${kept.map((token) => token.raw).join(";")}`;
  });
}

export function removeBridgeEntries(content, modId, workshopIds) {
  const withoutMod = removeIniListEntries(content, "Mods", [modId]);
  return removeIniListEntries(withoutMod, "WorkshopItems", workshopIds || []);
}

// Java's String.trim(): every char up to U+0020 comes off both ends.
function javaTrim(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

// Whether the game will compare players' Lua files, read exactly the way
// 42.20 reads the file, because this answer decides both the status the
// operator sees and whether a switch to Local writes DoLuaChecksum=false:
//   - ConfigFile.read trims the whole line, skips blank and `#` lines, then
//     split("=") with no per-part trim: the key must be exactly
//     "DoLuaChecksum" (so `DoLuaChecksum =` is some other, unknown option)
//     and the value is the text between the first "=" and the next one;
//   - ServerOptions starts from the default (true) and parses every line in
//     order; BooleanConfigOption accepts true/false/1/0 ignoring case and
//     ignores anything else (` false`, `yes`, empty), keeping the value
//     from before -- so the last VALID assignment wins.
// The looser anchored pattern the writers use still finds those odd lines;
// setChecksumFalse() rewrites them into a form the game reads.
export function getEffectiveChecksum(content) {
  let effective = true;
  for (const rawLine of String(content ?? "").split("\n")) {
    const line = javaTrim(rawLine);
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, value = ""] = line.split("=");
    if (key !== "DoLuaChecksum") continue;
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1") effective = true;
    else if (lower === "false" || lower === "0") effective = false;
  }
  return effective;
}

// The raw value of the first DoLuaChecksum line, or null when the key is
// missing -- shown in a preview step as "before".
export function getChecksumRawValue(content) {
  const match = keyLinePattern("DoLuaChecksum").exec(String(content ?? ""));
  return match ? match[3].trim() : null;
}

// Sets every DoLuaChecksum assignment to a canonical `DoLuaChecksum=false`
// (no space before or after "=": the game would ignore either, see
// getEffectiveChecksum), or appends one when the key is missing. A no-op
// when the game already reads the check as off, so a hand-written "False"
// or "0" is not churned. If some line the anchored pattern can't see still
// turns it back on, a final assignment is appended: the game applies the
// last valid one.
export function setChecksumFalse(content) {
  const text = String(content ?? "");
  if (!getEffectiveChecksum(text)) return text;
  if (!keyLinePattern("DoLuaChecksum").test(text)) {
    return appendKeyLine(text, "DoLuaChecksum", "false");
  }
  const next = text.replace(keyLinePattern("DoLuaChecksum", "gm"), (line, indent) => `${indent}DoLuaChecksum=false`);
  return getEffectiveChecksum(next) ? appendKeyLine(next, "DoLuaChecksum", "false") : next;
}

// Puts `value` back into `key`'s list at `index` (clamped to the list's
// length), or restores a `key=value` line when the line is gone. Used by the
// mods.js guard to undo a removal of an entry the operator can't see is
// managed elsewhere; never called to add an entry that wasn't there before.
export function insertIniListEntry(content, key, value, index) {
  const text = String(content ?? "");
  const pattern = keyLinePattern(key);
  const match = pattern.exec(text);
  if (!match) return appendKeyLine(text, key, value);
  const tokens = splitListValue(match[3]);
  if (tokens.some((token) => token.id === value)) return text;
  const raws = tokens.map((token) => token.raw);
  raws.splice(Math.max(0, Math.min(index, raws.length)), 0, value);
  return text.replace(pattern, () => `${match[1]}${key}${match[2]}=${raws.join(";")}`);
}
