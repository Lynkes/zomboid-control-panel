/**
 * Pure text helpers for the three server.ini keys PanelBridge delivery
 * touches: Mods=, WorkshopItems= and DoLuaChecksum=. No fs here -- callers
 * (services/bridgeDelivery.js) own reading, locking, backing up and writing,
 * and hand these functions LF-normalized content.
 *
 * Two readings, on purpose:
 *   - the WRITERS (and parseIniList) find a key with the same anchored
 *     `^[ \t]*Key[ \t]*=` shape as iniKeyWrite.js and mods.js, so a key name
 *     that merely appears inside another field's free text
 *     (PublicDescription, ServerWelcomeMessage) is never read or rewritten;
 *   - hasBridgeEntries(), readGameIniList() and getEffectiveChecksum()
 *     answer what the GAME reads, following 42.20's own parser, because
 *     those answers decide what the operator is told and whether a write is
 *     accepted. Every write is re-read with them.
 *
 * List entries are compared the way GameServer.main reads them: split on
 * `;`, trimmed, empty entries dropped. Mods= also loses every backslash
 * first (`\ZCPB` is the same mod); WorkshopItems= does
 * not -- a token counts only when it is a valid Steam id as it stands, so
 * `\3712345678` downloads nothing. Entries this module adds are written bare,
 * the mods.js convention. Entries it does not own are left byte-for-byte as
 * they were, in their original order.
 */
import { escapeRegExp } from "./regex.js";

// SteamUtils.isValidSteamID's upper bound (an unsigned 64-bit id).
const MAX_STEAM_ID = 18446744073709551615n;

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

// Java's String.trim(): every char up to U+0020 comes off both ends.
function javaTrim(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

// SteamUtils.isValidSteamID + convertStringToSteamID: `new BigInteger(s)`,
// so an optional sign and decimal digits and nothing else (no backslash, no
// inner space), within 0..2^64-1. Returns the id in its plain decimal form
// (`03712345678` is item 3712345678 to the game), or null for a token the
// game drops. ASCII digits only: the other Unicode digits BigInteger also
// takes are read as "not this id", which at worst adds a bare copy.
function steamIdOf(token) {
  if (!/^[+-]?[0-9]+$/.test(token)) return null;
  const id = BigInt(token.replace(/^\+/, ""));
  return id >= 0n && id <= MAX_STEAM_ID ? id.toString() : null;
}

// One list token as GameServer.main reads it (42.20, offsets 1575-1661 and
// 1774-1867): Mods= tokens lose every backslash, then are trimmed;
// WorkshopItems= tokens are only trimmed, and a valid Steam id compares in
// its plain decimal form. Anything else is compared as trimmed text.
function entryId(key, raw) {
  if (key === "WorkshopItems") {
    const token = javaTrim(String(raw));
    return steamIdOf(token) ?? token;
  }
  return javaTrim(String(raw).replace(/\\/g, ""));
}

// The raw, non-empty tokens of one list value, each paired with its
// normalized form. Raw tokens are kept so a rewrite never reformats an entry
// the panel doesn't own (a `\`-prefixed id stays `\`-prefixed).
function splitListValue(key, value) {
  return String(value)
    .split(";")
    .map((raw) => ({ raw: raw.trim(), id: entryId(key, raw) }))
    .filter((token) => token.id.length > 0);
}

// Reads the FIRST `key` line -- the line every panel writer (mods.js, the
// helpers below) edits. What the game applies is readGameIniList().
export function parseIniList(content, key) {
  const match = keyLinePattern(key).exec(String(content ?? ""));
  if (!match) return { present: false, entries: [] };
  return { present: true, entries: splitListValue(key, match[3]).map((token) => token.id) };
}

// Every assignment the game reads from a server .ini, in file order.
// ConfigFile.read (42.20): BufferedReader lines (\n, \r or \r\n), each
// trimmed with Java's trim(); blank lines, `#` lines and lines without "="
// are skipped; then split("=") with no per-part trim. The option name is the
// text before the first "=" exactly -- `Mods =x` names an option "Mods " the
// game doesn't have and ignores -- and the value is the text up to the next
// "=" ("" when there is none). ServerOptions.loadServerTextFile then applies
// the known names in order, so with a duplicated key the last line wins.
function gameAssignments(content) {
  const assignments = [];
  for (const rawLine of String(content ?? "").split(/\r\n|\r|\n/)) {
    const line = javaTrim(rawLine);
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, value = ""] = line.split("=");
    assignments.push([key, value]);
  }
  return assignments;
}

// The list the game ends up with for Mods= or WorkshopItems=: the value of
// the last line it reads for the key (see gameAssignments), split and
// filtered the way GameServer.main does it (see entryId). WorkshopItems=
// keeps only valid Steam ids, in plain decimal form.
export function readGameIniList(content, key) {
  let value = null;
  for (const [name, text] of gameAssignments(content)) {
    if (name === key) value = text;
  }
  if (value === null) return { present: false, entries: [] };
  const entries = [];
  for (const raw of value.split(";")) {
    if (key === "WorkshopItems") {
      const id = steamIdOf(javaTrim(raw));
      if (id !== null) entries.push(id);
    } else {
      const id = entryId(key, raw);
      if (id) entries.push(id);
    }
  }
  return { present: true, entries };
}

// Whether the game will load the bridge from this file: its mod id in the
// Mods= list and its item id in the WorkshopItems= list the game reads.
export function hasBridgeEntries(content, modId, workshopId) {
  const id = workshopId ? steamIdOf(javaTrim(String(workshopId))) : null;
  return {
    mods: readGameIniList(content, "Mods").entries.includes(modId),
    workshopItems: id !== null && readGameIniList(content, "WorkshopItems").entries.includes(id),
  };
}

// Appends `value` to the first `key` line (the one mods.js edits too), or
// adds a `key=value` line when the key is missing entirely. A rewritten line
// always reads `key=` with nothing before the "=": `Mods =…` is a different
// option to the game (see gameAssignments), so such a line is rewritten even
// when it already lists the entry. A no-op when the entry is already listed
// on a line the game reads. The game applies the LAST line of a duplicated
// key, so callers refuse to add entries to such a file at all (§6.7).
function addListEntry(content, key, value) {
  const pattern = keyLinePattern(key);
  const match = pattern.exec(content);
  if (!match) return appendKeyLine(content, key, value);
  const id = entryId(key, value);
  const listed = splitListValue(key, match[3]).some((token) => token.id === id);
  if (listed && match[2] === "") return content;
  const existing = match[3].trim().replace(/;+$/, "").trim();
  let nextValue = value;
  if (listed) nextValue = existing;
  else if (existing) nextValue = `${existing};${value}`;
  return content.replace(pattern, () => `${match[1]}${key}=${nextValue}`);
}

export function addBridgeEntries(content, modId, workshopId) {
  let next = addListEntry(String(content ?? ""), "Mods", modId);
  if (workshopId) next = addListEntry(next, "WorkshopItems", String(workshopId));
  return next;
}

// What a removal matches: the entry's normalized form, backslashes dropped
// for WorkshopItems= too. The game ignores a `\3712345678` token, but taking
// it out along with the real one is always safe.
function removalId(key, raw) {
  return entryId(key, String(raw).replace(/\\/g, ""));
}

// Removes matches of `values` (see removalId) from EVERY `key` line, not
// just the first: a removal is always safe to over-apply, and a duplicated
// key is exactly where a leftover entry would otherwise survive. Lines with
// nothing to remove are returned untouched, and a line that loses an entry
// keeps its own spacing around "=": taking an entry out of a line the game
// ignores must not make the game start reading the rest of it.
export function removeIniListEntries(content, key, values) {
  const targets = new Set((values || []).filter(Boolean).map((value) => removalId(key, value)));
  if (targets.size === 0) return String(content ?? "");
  return String(content ?? "").replace(keyLinePattern(key, "gm"), (line, indent, spacing, value) => {
    const tokens = splitListValue(key, value);
    const kept = tokens.filter((token) => !targets.has(removalId(key, token.raw)));
    if (kept.length === tokens.length) return line;
    return `${indent}${key}${spacing}=${kept.map((token) => token.raw).join(";")}`;
  });
}

export function removeBridgeEntries(content, modId, workshopIds) {
  const withoutMod = removeIniListEntries(content, "Mods", [modId]);
  return removeIniListEntries(withoutMod, "WorkshopItems", workshopIds || []);
}

// Whether removeIniListEntries() would take `value` out of any `key` line:
// what a switch to panel-installed previews, offers and checks, so the
// preview lists exactly what the apply removes.
export function listsIniEntry(content, key, value) {
  const text = String(content ?? "");
  return removeIniListEntries(text, key, [value]) !== text;
}

// Whether the game will compare players' Lua files, read exactly the way
// 42.20 reads the file, because this answer decides both the status the
// operator sees and whether a switch to Local writes DoLuaChecksum=false:
//   - the key must be exactly "DoLuaChecksum" (see gameAssignments, so
//     `DoLuaChecksum =` is some other, unknown option);
//   - ServerOptions starts from the default (true) and parses every line in
//     order; BooleanConfigOption accepts true/false/1/0 ignoring case and
//     ignores anything else (` false`, `yes`, empty), keeping the value
//     from before -- so the last VALID assignment wins.
// The looser anchored pattern the writers use still finds those odd lines;
// setChecksumFalse() rewrites them into a form the game reads.
export function getEffectiveChecksum(content) {
  let effective = true;
  for (const [key, value] of gameAssignments(content)) {
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
// Like addListEntry, the rewritten line reads `key=`.
export function insertIniListEntry(content, key, value, index) {
  const text = String(content ?? "");
  const pattern = keyLinePattern(key);
  const match = pattern.exec(text);
  if (!match) return appendKeyLine(text, key, value);
  const tokens = splitListValue(key, match[3]);
  const id = entryId(key, value);
  if (tokens.some((token) => token.id === id)) return text;
  const raws = tokens.map((token) => token.raw);
  raws.splice(Math.max(0, Math.min(index, raws.length)), 0, value);
  return text.replace(pattern, () => `${match[1]}${key}=${raws.join(";")}`);
}
