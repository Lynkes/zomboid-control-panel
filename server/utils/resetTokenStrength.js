/**
 * How guessable a hand-made data/reset-token.txt is.
 *
 * SECURITY (2026-10-05, A2): POST /api/auth/reset-password used to delete
 * reset-token.txt after 5 wrong tokens from any mix of addresses, so a
 * stranger could destroy every token the operator made. The deletion is
 * gone; what keeps online guessing infeasible now is the token itself (plus
 * the per-address reset limiter and the 24-hour lifetime), so a token has
 * to be long AND unpredictable. The panel's own button writes 48 random hex
 * characters; this check is for the ones operators write by hand.
 *
 * It counts the characters an attacker could not predict from the ones
 * before them. A character is predictable when it:
 *   - continues a run of at least three characters that each repeat, step
 *     by one (abc, 987) or sit next to each other on a keyboard row (qwe,
 *     asd) -- from the run's third character on, so a random token's
 *     occasional "aa" or "34" isn't held against it; or
 *   - ends three characters that already appeared together earlier in the
 *     token (the second "changeme" in "changemechangeme" adds two
 *     characters, not eight).
 * Random tokens of RESET_TOKEN_MIN_LENGTH characters from any generator
 * (hex, base64, letters and digits, digits only) keep nearly all of their
 * characters; "aaaa...", "abcd...", "0123456789abcdef" twice or a word
 * repeated keep a handful. Dictionary words are not detected: the help
 * text and docs say to use a password generator.
 */

const KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

// At least this many unpredictable characters. Even drawn from digits alone
// that's over 66 bits, far beyond what the reset limiter lets anyone try in
// a token's 24 hours.
export const RESET_TOKEN_MIN_UNPREDICTABLE_CHARS = 20;

function isKeyboardNeighbour(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    const i = row.indexOf(x);
    if (i !== -1 && (row[i + 1] === y || row[i - 1] === y)) return true;
  }
  return false;
}

function isPredictableStep(previous, current) {
  if (previous === current) return true;
  const step = current.codePointAt(0) - previous.codePointAt(0);
  if (step === 1 || step === -1) return true;
  return isKeyboardNeighbour(previous, current);
}

export function countUnpredictableChars(token) {
  const chars = Array.from(typeof token === "string" ? token : "");
  const seenTrigrams = new Set();
  let unpredictable = 0;
  for (let i = 0; i < chars.length; i++) {
    let predictable = false;
    if (i >= 2) {
      const trigram = chars[i - 2] + chars[i - 1] + chars[i];
      if (
        isPredictableStep(chars[i - 2], chars[i - 1]) &&
        isPredictableStep(chars[i - 1], chars[i])
      ) {
        predictable = true;
      } else if (seenTrigrams.has(trigram)) {
        predictable = true;
      }
      seenTrigrams.add(trigram);
    }
    if (!predictable) unpredictable += 1;
  }
  return unpredictable;
}

export function isResetTokenUnpredictable(token) {
  return countUnpredictableChars(token) >= RESET_TOKEN_MIN_UNPREDICTABLE_CHARS;
}
