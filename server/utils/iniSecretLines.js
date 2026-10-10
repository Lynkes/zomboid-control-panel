// Secret-shaped lines of a server .ini (SENSITIVE_FIELD_RE: RCONPassword, the
// join Password, every *Token, ...): leaving them out of a saved template,
// masking them for the raw editor, putting the real value back when the
// editor sends the mask back, and keeping the live ones when a template is
// applied. Moved out of routes/serverFiles.js unchanged (it still exports
// the first three); keepLiveSecretIniLines() is new.
import {
  SENSITIVE_FIELD_RE,
  isMaskedSecret,
  maskSecretValue,
} from "./sanitize.js";

// Drop any `Key=Value` line whose key looks secret-like (SENSITIVE_FIELD_RE
// -- same regex GET /app-settings already trusts, not a second hand-kept
// list) from a raw .ini file's text, preserving every other line -- comments,
// blank lines, formatting -- byte for byte. Used only when SAVING a template
// snapshot (POST /templates): that snapshot's `iniRaw` is later written into
// the live .ini on apply, so a masked placeholder string here would land in
// the live RCON/join password field on apply and break RCON -- omitting the
// line entirely is safe because apply puts the live .ini's own secret lines
// back (keepLiveSecretIniLines() below); it used to write the snapshot as it
// was, which removed the RCON password, the join password and every token
// from the live server. Line-level rather than parse-then-reserialize: reusing
// parseIni()/toIni() here would rewrite every OTHER line too, and toIni()'s
// own merge semantics keep an omitted key's ORIGINAL line untouched --
// exactly the opposite of what a strip needs.
export function stripSensitiveIniLines(content) {
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      return true;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) return true;
    const key = trimmed.substring(0, eqIndex).trim();
    return !SENSITIVE_FIELD_RE.test(key);
  });
  return kept.join("\n");
}

// GET /raw/:type=ini's read-side counterpart to the structured /ini route's
// maskSensitiveObject(): mask a secret-shaped `Key=Value` line's VALUE in
// place, byte-for-byte otherwise (everything up to and including the `=`,
// comments, blank lines, formatting). Unlike stripSensitiveIniLines() above,
// this can't drop the line -- the raw editor's PUT round-trips this exact
// text back, and reconcileMaskedIniLines() below needs the line to still be
// there (by key) to know what it's reconciling against.
export function maskSensitiveIniLines(content) {
  const lines = content.split(/\r?\n/);
  const masked = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      return line;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) return line;
    const key = line.substring(0, eqIndex).trim();
    const value = line.substring(eqIndex + 1);
    if (!SENSITIVE_FIELD_RE.test(key) || !value) return line;
    return `${line.substring(0, eqIndex + 1)}${maskSecretValue(value)}`;
  });
  return masked.join("\n");
}

// PUT /raw/:type=ini's write-side counterpart. Unlike the structured /ini
// route, the raw editor round-trips ONE FULL TEXT BLOB on every save with no
// per-line diff against what the operator actually touched -- Save always
// resubmits the whole thing, regardless of which line changed. So masking
// the read alone would let ANY raw-mode save (editing an unrelated line)
// silently overwrite a live secret with the "••••••••xxxx"
// placeholder text the moment that key's line comes back unchanged.
//
// This reconciles by KEY, never by line position -- reordering lines or
// inserting a new one above a secret must not misalign the match -- and it
// REFUSES the entire save (returns ok:false, writes nothing) the instant a
// masked value can't be resolved unambiguously, rather than guessing or
// best-effort patching part of the file. A rejected save costs the operator
// one retry; a half-reconciled write costs them their live server config,
// which is a strictly worse failure than the secret leak this exists to
// close. Three ways a masked line fails to resolve, all refused the same
// way: the key doesn't exist in the live file any more; the key exists more
// than once in either the live file or the incoming submission (which one
// would even be "the" secret to restore?); or -- the case a naive line-diff
// would miss entirely -- the key existed live with a real value but is
// ABSENT from the incoming content altogether, meaning the operator deleted
// a line that reads as bullets, quite possibly without realizing it was a
// real credential. All four are treated as "can't safely tell what the
// operator intended" rather than silently picking a side.
export function reconcileMaskedIniLines(incomingContent, liveContent) {
  const indexIniLines = (text) => {
    const lines = text.split(/\r?\n/);
    const byKey = new Map();
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) return;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ index, line, value });
    });
    return byKey;
  };

  const incomingByKey = indexIniLines(incomingContent);
  const liveByKey = indexIniLines(liveContent);
  const outLines = incomingContent.split(/\r?\n/);

  for (const [key, entries] of incomingByKey) {
    if (!SENSITIVE_FIELD_RE.test(key)) continue;
    const maskedEntries = entries.filter((e) => isMaskedSecret(e.value));
    if (maskedEntries.length === 0) continue;

    const liveEntries = liveByKey.get(key) || [];
    if (maskedEntries.length > 1 || liveEntries.length !== 1) {
      return { ok: false, reason: "unresolvable", key };
    }
    outLines[maskedEntries[0].index] = liveEntries[0].line;
  }

  for (const [key, liveEntries] of liveByKey) {
    if (!SENSITIVE_FIELD_RE.test(key)) continue;
    if (liveEntries.length !== 1 || !liveEntries[0].value) continue;
    if (!incomingByKey.has(key)) {
      return { ok: false, reason: "removed", key };
    }
  }

  return { ok: true, content: outLines.join("\n") };
}

// The key of a secret-shaped assignment line (the lines stripSensitiveIniLines
// drops), else null for a blank line, a comment or any other setting.
function secretKeyOf(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex <= 0) return null;
  const key = trimmed.substring(0, eqIndex).trim();
  return SENSITIVE_FIELD_RE.test(key) ? key : null;
}

/**
 * A template's INI text, ready to replace the live .ini: with the live file's
 * secret lines in place of the template's.
 *
 * A saved template never holds them (stripSensitiveIniLines() drops them when
 * it is saved), so writing it over the live file removed the RCON password,
 * the join password and every *Token line from a server that had them. The
 * live value of each secret key now goes in:
 *   - a key the template has a line for (a template saved before secrets were
 *     left out can still hold an old real value or the mask) takes the live
 *     file's line(s), at the template line's place;
 *   - a key the template has no line for gets the live file's line(s) at the
 *     end of the file;
 *   - a key the live file has no line for keeps the template's line, unless it
 *     is the mask placeholder, which is dropped.
 * The template's own line ending style is kept.
 *
 * @param {string} templateContent - The template's iniRaw.
 * @param {string} liveContent - The live .ini's text ("" when there is none).
 * @returns {string}
 */
export function keepLiveSecretIniLines(templateContent, liveContent) {
  const template = String(templateContent ?? "");
  const lineEnding = template.includes("\r\n") ? "\r\n" : "\n";

  const liveByKey = new Map();
  for (const line of String(liveContent ?? "").split(/\r?\n/)) {
    const key = secretKeyOf(line);
    if (key === null) continue;
    if (!liveByKey.has(key)) liveByKey.set(key, []);
    liveByKey.get(key).push(line);
  }

  const out = [];
  const placed = new Set();
  for (const line of template.split(/\r?\n/)) {
    const key = secretKeyOf(line);
    if (key === null) {
      out.push(line);
    } else if (liveByKey.has(key)) {
      if (!placed.has(key)) {
        out.push(...liveByKey.get(key));
        placed.add(key);
      }
    } else if (!isMaskedSecret(line.slice(line.indexOf("=") + 1).trim())) {
      out.push(line);
    }
  }

  const appended = [];
  for (const [key, lines] of liveByKey) {
    if (!placed.has(key)) appended.push(...lines);
  }
  if (appended.length > 0) {
    // Before the final empty piece a trailing line break leaves, so the file
    // still ends with one.
    const insertAt = out.length > 0 && out[out.length - 1] === "" ? out.length - 1 : out.length;
    out.splice(insertAt, 0, ...appended);
  }
  return out.join(lineEnding);
}
