import { SENSITIVE_FIELD_RE } from "./sanitize.js";

// SECURITY (2026-10-20, access-control audit): the copy of the panel
// database a world backup carries when "include the panel database" is on.
// A backup leaves the machine with backups.download, which the seeded
// Technician holds, so the copy holds no credential: every key that looks
// secret-like (SENSITIVE_FIELD_RE: passwords and their bcrypt hashes,
// tokens, recovery codes, webhooks, cookies, Steam sessions, ...) and every
// session record (refresh sessions and their tombstones) is left out,
// wherever it sits in the tree. Restore never reads this file back (it only
// swaps the world folder), so nothing the live database holds is replaced
// by it; the note at the top says what was left out, for anyone reading it
// by hand.
const SESSION_KEY_RE = /session|refresh/i;

export const PANEL_DB_REDACTION_NOTE =
  "Copy of the panel database for a world backup: passwords, password hashes, sessions, recovery codes, tokens and other secrets are left out. Restoring a backup never applies this file.";

function isRedactedKey(key) {
  return SENSITIVE_FIELD_RE.test(key) || SESSION_KEY_RE.test(key);
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (isRedactedKey(key)) continue;
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}

/**
 * The panel database `data` (db.json's parsed content) with every credential
 * and session left out, plus a `_backupRedaction` note. Never mutates `data`.
 */
export function redactPanelDbForBackup(data) {
  const redacted = redactValue(data && typeof data === "object" ? data : {});
  return { _backupRedaction: PANEL_DB_REDACTION_NOTE, ...redacted };
}
