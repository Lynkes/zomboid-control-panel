// bug-hunt-2026-09-18 (round 16, silently-altered player-action text sweep):
// server/services/rcon.js's sanitizeForBanReason() -- used by BOTH
// kickPlayer() and banPlayer() -- silently folds curly quotes/accents to
// plain ASCII, drops anything outside a narrow [a-zA-Z0-9\s.,!?'-] whitelist,
// and truncates to 100 characters, with no error and no signal back to the
// operator. banPlayer() already computes and returns the actual `sentReason`
// specifically because it can differ from what was typed (see its own
// comment, docs/qa/kevin-adversarial-findings.md Finding 2) -- but nothing
// in the client ever read it; the confirm dialog echoed the operator's raw
// input verbatim, and the success toast never mentioned an alteration. A
// banned/kicked player could see a reason with emoji, non-Latin script, or
// disallowed punctuation stripped out (or the tail cut off past 100 chars),
// while the moderator who typed it never found out.
//
// This is a literal client-side mirror of foldToRconAscii() +
// sanitizeForBanReason()'s own whitelist + truncation -- kept as a copy, not
// a shared import across the client/server boundary, same convention as
// isValidServerName/isValidPort elsewhere in this app. Used to show a live
// "this is what will actually be sent" preview before the operator submits,
// rather than only finding out after the fact.

// Mirrors server/services/rcon.js's LATIN_TRANSLITERATION_MAP exactly --
// keep the two in sync if that table ever changes.
const LATIN_TRANSLITERATION_MAP: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
  À: 'A', Á: 'A', Â: 'A', Ã: 'A', Ä: 'A', Å: 'A',
  ç: 'c', Ç: 'C',
  è: 'e', é: 'e', ê: 'e', ë: 'e',
  È: 'E', É: 'E', Ê: 'E', Ë: 'E',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  Ì: 'I', Í: 'I', Î: 'I', Ï: 'I',
  ñ: 'n', Ñ: 'N',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o',
  Ò: 'O', Ó: 'O', Ô: 'O', Õ: 'O', Ö: 'O',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  Ù: 'U', Ú: 'U', Û: 'U', Ü: 'U',
  ý: 'y', ÿ: 'y', Ý: 'Y',
  œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE',
}

// Mirrors rcon.js's foldToRconAscii().
function foldToRconAscii(input: string): string {
  return String(input ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[…]/g, '...')
    .replace(/[À-ɏ]/g, (ch) => LATIN_TRANSLITERATION_MAP[ch] ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Mirrors rcon.js's sanitizeForBanReason(): foldToRconAscii(), then the
// ban-reason-specific punctuation whitelist, then the 100-char cap.
export function previewBanReason(input: string): string {
  if (!input) return ''
  return foldToRconAscii(input)
    .replace(/[^a-zA-Z0-9\s.,!?'-]/g, '')
    .substring(0, 100)
}

// True when the server would actually send something DIFFERENT from what
// the operator typed, once ordinary whitespace (leading/trailing, or
// multiple spaces collapsed to one -- foldToRconAscii() always does this,
// even for already-clean ASCII text) is normalized away first. Without this
// normalization, a plain reason with a single trailing space would always
// "differ" and the note would fire constantly for a change no one cares
// about, burying the real signal (a dropped character or a truncation).
export function banReasonWillBeAltered(input: string): boolean {
  if (!input) return false
  const triviallyNormalized = input.trim().replace(/\s+/g, ' ')
  return previewBanReason(input) !== triviallyNormalized
}
