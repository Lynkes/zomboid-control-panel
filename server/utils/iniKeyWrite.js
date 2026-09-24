import { escapeRegExp } from "./regex.js";

/**
 * Anchored, single-key read/write helpers for a raw INI file's text content.
 *
 * 2026-08-31: server.js had four independent call sites (ensureRconConfigured,
 * POST /configure-rcon, applyUpnpToIni, POST /configure-network -- two of
 * them literal duplicates of each other) that each hand-rolled their own
 * `content.includes("Key=")` existence guard and a global, UNANCHORED
 * `content.replace()` on a "Key=" wildcard-value pattern. Both are unanchored:
 * `.includes("RCONPassword=")` matches that substring ANYWHERE in the file,
 * and the unanchored replace rewrites every line containing it -- including
 * inside an operator's own free-text field (ServerWelcomeMessage,
 * PublicDescription) if it happens to contain the literal text
 * "RCONPassword=". The result was config corruption plus a credential
 * written somewhere it was never meant to go, not just a missed update.
 * mods.js already carries the fix for the identical shape (18 ini-write
 * sites, fixed 2026-08-27): anchor with `^[ \t]*KEY[ \t]*=` and the `m` flag,
 * so a match can only be a real assignment line, never a substring inside
 * another field's value. This module is that same fix, pulled out into one
 * shared, tested implementation instead of a fifth (and now a
 * sixth-through-ninth) hand-rolled copy.
 *
 * `[ \t]*` around the key tolerates "Key = value" (spaces around `=`), the
 * same whitespace serverFiles.js's parseIni()/toIni() and
 * findDuplicateIniKeys() already tolerate -- see mods.js:2117-2132 for why an
 * anchored pattern with no whitespace tolerance is its own, subtler version
 * of this bug against a hand-edited or PZ-regenerated file.
 */

/** True if `key` appears as a real assignment line (not inside a comment or another field's free text). */
export function hasIniKeyLine(content, key) {
  return new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=`, "m").test(content);
}

/** True if `key`'s assignment line's value is exactly `value` (used for "is this already configured correctly" fast paths -- an unanchored .includes() here can false-positive off a free-text field that happens to contain the same KEY=VALUE substring). */
export function hasIniKeyValue(content, key, value) {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*${escapeRegExp(String(value))}[ \\t]*$`,
    "m",
  ).test(content);
}

/** Sets `key`'s assignment line to `value`, replacing the first (and only expected) real assignment line if one exists, else appending a new one. Never touches `key`'s substring anywhere else in the file. */
export function setIniKeyLine(content, key, value) {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content}\n${key}=${value}`;
}

/**
 * 2026-09-18: every one of this module's call sites in server.js
 * (ensureRconConfigured, POST /configure-rcon, applyUpnpToIni, POST
 * /configure-network) used to `fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g,
 * "\n")` before calling setIniKeyLine()/hasIniKeyValue() -- normalizing to LF
 * so the `m`-flag regexes above have a single, predictable line terminator to
 * anchor against -- and then wrote that LF-only string straight back with
 * writeFileAtomic(), with nothing ever converting it back. A real PZ-written
 * server .ini is CRLF (confirmed against a live B42 dedicated-server install,
 * 420/420 lines CRLF, zero bare LF): auto-configuring RCON on first boot, or
 * saving the RCON/UPnP/network-port panel once, silently rewrote every OTHER
 * line's terminator in the file too -- not just the 1-2 keys actually being
 * changed. serverFiles.js's toIni() already had this exact bug and was fixed
 * for it (573f63fd, see toIni()'s own comment) by remembering and restoring
 * the file's original line ending; these call sites never got the same fix
 * because they don't go through toIni() at all. `withOriginalLineEnding()`
 * is that same fix, factored out so all four sites (and any future one)
 * share it instead of re-forgetting it individually.
 */
export function withOriginalLineEnding(rawContent) {
  const lineEnding = rawContent.includes("\r\n") ? "\r\n" : "\n";
  return { content: rawContent.replace(/\r\n/g, "\n"), lineEnding };
}

/** Restores `lineEnding` (as captured by withOriginalLineEnding()) across an LF-normalized string before it's written back to disk. A no-op when the original was already LF-only. */
export function restoreLineEnding(content, lineEnding) {
  return lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}
