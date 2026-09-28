/**
 * Pure text helpers for the three server.ini keys PanelBridge delivery
 * touches: Mods=, WorkshopItems= and DoLuaChecksum=. No fs here -- callers
 * (services/bridgeDelivery.js) own reading, locking, backing up and writing,
 * and hand these functions LF-normalized content.
 *
 * Every key match uses the same anchored `^[ \t]*Key[ \t]*=` shape as
 * iniKeyWrite.js and mods.js, so a key name that merely appears inside
 * another field's free text (PublicDescription, ServerWelcomeMessage) is
 * never read or rewritten.
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

export function parseIniList(content, key) {
  const match = keyLinePattern(key).exec(String(content ?? ""));
  if (!match) return { present: false, entries: [] };
  return { present: true, entries: splitListValue(match[3]).map((token) => token.id) };
}

export function hasBridgeEntries(content, modId, workshopId) {
  const mods = parseIniList(content, "Mods").entries;
  const items = parseIniList(content, "WorkshopItems").entries;
  return {
    mods: mods.includes(modId),
    workshopItems: Boolean(workshopId) && items.includes(String(workshopId)),
  };
}

// Appends `value` to the first `key` line (the one mods.js and the game's
// own first-match readers agree on), or adds a `key=value` line when the key
// is missing entirely. A no-op when the entry is already listed.
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

// The game treats a missing DoLuaChecksum as true (ServerOptions default).
// With a duplicated key this answers "true" unless EVERY assignment says
// false, so a caller asking "are players' Lua files compared?" never gets a
// reassuring answer the file doesn't fully back.
export function getEffectiveChecksum(content) {
  const values = [];
  const pattern = keyLinePattern("DoLuaChecksum", "gm");
  let match;
  while ((match = pattern.exec(String(content ?? ""))) !== null) {
    values.push(match[3].trim().toLowerCase());
  }
  if (values.length === 0) return true;
  return !values.every((value) => value === "false");
}

// The raw value of the first DoLuaChecksum line, or null when the key is
// missing -- shown in a preview step as "before".
export function getChecksumRawValue(content) {
  const match = keyLinePattern("DoLuaChecksum").exec(String(content ?? ""));
  return match ? match[3].trim() : null;
}

// Sets every DoLuaChecksum assignment to false, or appends one when the key
// is missing. A no-op when the file already turns the check off, so a
// hand-written "False" is not churned into "false".
export function setChecksumFalse(content) {
  const text = String(content ?? "");
  if (!getEffectiveChecksum(text)) return text;
  const pattern = keyLinePattern("DoLuaChecksum", "gm");
  if (!keyLinePattern("DoLuaChecksum").test(text)) {
    return appendKeyLine(text, "DoLuaChecksum", "false");
  }
  return text.replace(pattern, (line, indent, spacing) => `${indent}DoLuaChecksum${spacing}=false`);
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
