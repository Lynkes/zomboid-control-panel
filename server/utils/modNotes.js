// Mod notes: a short text an admin keeps on a Workshop item ("needs the
// B42.13 patch", "ask Sam before removing"), shared panel-wide and stored in
// the panel database (database/init.js mod_notes).

export const MOD_NOTE_LIMITS = Object.freeze({
  textMax: 1000,
  // Notes kept at most; a new note past it is refused, an edit never is.
  maxNotes: 5000,
});

const WORKSHOP_ID = /^\d{1,15}$/;

export function isNoteWorkshopId(value) {
  return typeof value === "string" && WORKSHOP_ID.test(value);
}

/**
 * Cleans a note text: line breaks as "\n", trimmed. Returns { ok: true, text }
 * (text "" means "delete the note") or { ok: false, reason } with reason
 * "type" (not a string), "length" (over textMax after trimming) or "chars"
 * (a control character other than a tab or a line break).
 */
export function cleanModNoteText(value) {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length > MOD_NOTE_LIMITS.textMax) return { ok: false, reason: "length" };
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 9 || code === 10) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return { ok: false, reason: "chars" };
  }
  return { ok: true, text };
}
