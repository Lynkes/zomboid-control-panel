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
 * before them, ignoring case. A character is predictable when it:
 *   - continues a run of at least three characters where each step repeats
 *     a character, moves to the next or previous one (abc, 987), or moves
 *     to a key touching the last one on a keyboard -- along a row (qwe),
 *     down or up a column (1qaz, zaq1) or with Shift (1!2@) -- counted from
 *     the run's third character on, so a random token's occasional "aa" or
 *     "34" isn't held against it;
 *   - continues a run where every step is the same size: the same move
 *     along a keyboard row from the third character (qetu), any other
 *     fixed code-point step or keyboard move from the fourth (aceg, 2468,
 *     zxvt);
 *   - does either of those counting every second or every third character,
 *     from that sequence's fourth character on, which is what interleaving
 *     two or three runs looks like (a1b2c3, a1!b2@c3#);
 *   - ends three characters that already appeared together earlier in the
 *     token (the second "changeme" in "changemechangeme" adds two
 *     characters, not eight).
 * And the token needs at least RESET_TOKEN_MIN_DISTINCT_CHARS different
 * characters.
 *
 * Random tokens of RESET_TOKEN_MIN_LENGTH characters from a generator keep
 * nearly all of their characters: of 100,000 tokens each of 32 hex, base64
 * or letters-and-digits characters, no more than 3 fall short, and none of
 * 48 hex characters (what the panel writes, and `openssl rand -hex 24`) or
 * of UUIDs do. Digits alone repeat and step by one far more often by
 * chance; about 1 in 230 tokens of 32 digits is refused. What it can't see
 * is meaning: a sentence, a quote or a few words strung together look like
 * any other characters.
 *
 * SECURITY (2026-10-05, A2): so on its own this check passed panel-themed
 * phrases ("zomboid-control-panel-reset-token"), sentences, word lists, the
 * digits of pi and e and symbol templates (Aa1!Bb2@...), and a remote
 * stranger reset the admin password by guessing one. A hand-made token now
 * also has to be what every generator the docs name writes
 * (resetTokenWeakness()): hex digits, in one piece or in dash-separated
 * groups like a UUID, with a generator's mix of digits and letters -- at
 * least one letter, and digits for at least a quarter of it, which random
 * hex (10 digits in 16) all but always has and pure numbers or hex words
 * ("deadbeefcafe...") don't. Hex spells only a handful of words, so what's
 * left to guess is the generator's randomness. (A hash of something
 * guessable is hex too; no check can see that, and the docs say not to.)
 * The pattern check above then runs on the hex digits alone. Of a million
 * random tokens of 32 hex characters (`openssl rand -hex 16`) about 36 are
 * refused, and about 20 of a million UUIDs; none of 300,000 of 48 (the
 * panel's button, `openssl rand -hex 24` and the docs' PowerShell line).
 */

// Where each key sits on a US QWERTY keyboard: the row, and how far the key
// is from the keyboard's left edge in key widths, so the rows keep their
// real stagger (Tab is 1.5 keys wide, Caps Lock 1.75, Shift 2.25). A
// shifted character sits on its key.
const KEYBOARD_ROWS = [
  [0, "`1234567890-=", "~!@#$%^&*()_+"],
  [1.5, "qwertyuiop[]\\", "QWERTYUIOP{}|"],
  [1.75, "asdfghjkl;'", 'ASDFGHJKL:"'],
  [2.25, "zxcvbnm,./", "ZXCVBNM<>?"],
];
const KEY_POSITIONS = new Map();
KEYBOARD_ROWS.forEach(([offset, keys, shiftedKeys], row) => {
  for (let i = 0; i < keys.length; i++) {
    const position = { row, x: offset + i };
    KEY_POSITIONS.set(keys[i], position);
    KEY_POSITIONS.set(shiftedKeys[i], position);
  }
});

// At least this many unpredictable characters. Hex digits carry 4 bits each,
// so that's 80 bits, far beyond what the reset limiter lets anyone try in a
// token's 24 hours.
export const RESET_TOKEN_MIN_UNPREDICTABLE_CHARS = 20;

// At least this many different characters (ignoring case). A token drawn
// from a handful of characters is easy to guess however they're arranged.
export const RESET_TOKEN_MIN_DISTINCT_CHARS = 8;

function fold(char) {
  return char.toLowerCase();
}

function codePoint(char) {
  return fold(char).codePointAt(0);
}

// The same character (ignoring case), the next or previous one, or a key
// touching this one: beside it in its row, or overlapping it in the row
// above or below (1-q, 2-q, q-a, a-z, e-d), with or without Shift.
function isSmallStep(a, b) {
  if (fold(a) === fold(b)) return true;
  const step = codePoint(b) - codePoint(a);
  if (step === 1 || step === -1) return true;
  const from = KEY_POSITIONS.get(a);
  const to = KEY_POSITIONS.get(b);
  if (!from || !to) return false;
  if (from.row === to.row) return Math.abs(from.x - to.x) <= 1;
  return Math.abs(from.row - to.row) === 1 && Math.abs(from.x - to.x) < 1;
}

function keyMove(a, b) {
  const from = KEY_POSITIONS.get(a);
  const to = KEY_POSITIONS.get(b);
  return from && to ? { rows: to.row - from.row, x: to.x - from.x } : null;
}

// a -> b and b -> c move the same way: the same code-point difference, of
// any size, or the same move on the keyboard.
function isSameStep(a, b, c) {
  if (codePoint(c) - codePoint(b) === codePoint(b) - codePoint(a)) return true;
  const first = keyMove(a, b);
  const second = keyMove(b, c);
  return Boolean(first && second && first.rows === second.rows && first.x === second.x);
}

function isSameRowKeyStep(a, b, c) {
  const first = keyMove(a, b);
  const second = keyMove(b, c);
  return Boolean(first && second && first.rows === 0 && second.rows === 0 && first.x === second.x);
}

// Whether chars[i] continues a run, looking back `stride` characters at a
// time: `smallRun` characters each a small step from the one before, or
// four that each move the same way.
function continuesRun(chars, i, stride, smallRun) {
  const at = (back) => chars[i - back * stride];
  if (i >= (smallRun - 1) * stride) {
    let run = true;
    for (let back = 0; back < smallRun - 1 && run; back++) {
      run = isSmallStep(at(back + 1), at(back));
    }
    if (run) return true;
  }
  return i >= 3 * stride && isSameStep(at(3), at(2), at(1)) && isSameStep(at(2), at(1), at(0));
}

function isPredictableAt(chars, i) {
  if (continuesRun(chars, i, 1, 3)) return true;
  if (i >= 2 && isSameRowKeyStep(chars[i - 2], chars[i - 1], chars[i])) return true;
  return continuesRun(chars, i, 2, 4) || continuesRun(chars, i, 3, 4);
}

export function countUnpredictableChars(token) {
  const chars = Array.from(typeof token === "string" ? token : "");
  const seenTrigrams = new Set();
  let unpredictable = 0;
  for (let i = 0; i < chars.length; i++) {
    let predictable = isPredictableAt(chars, i);
    if (i >= 2) {
      const trigram = fold(chars[i - 2] + chars[i - 1] + chars[i]);
      if (seenTrigrams.has(trigram)) predictable = true;
      seenTrigrams.add(trigram);
    }
    if (!predictable) unpredictable += 1;
  }
  return unpredictable;
}

export function countDistinctChars(token) {
  return new Set(Array.from(typeof token === "string" ? token : "").map(fold)).size;
}

export function isResetTokenUnpredictable(token) {
  return (
    countUnpredictableChars(token) >= RESET_TOKEN_MIN_UNPREDICTABLE_CHARS &&
    countDistinctChars(token) >= RESET_TOKEN_MIN_DISTINCT_CHARS
  );
}

// Hex digits, either case, in one piece or in groups joined by single dashes
// (a UUID from uuidgen or PowerShell's New-Guid).
const HEX_TOKEN_SHAPE = /^[0-9a-f]+(?:-[0-9a-f]+)*$/i;

// The token's hex digits without the dashes between groups, or null when it
// isn't written in hex.
export function resetTokenHexDigits(token) {
  if (typeof token !== "string" || !HEX_TOKEN_SHAPE.test(token)) return null;
  return token.replaceAll("-", "");
}

// At least one letter, and digits for at least a quarter of the hex. Random
// hex is 10 digits in 16, so of 32 characters fewer than 8 digits happens
// about 3 times in a million, and no letter at all far less often.
function hasGeneratorMix(hex) {
  const digits = hex.replace(/[^0-9]/g, "").length;
  return digits < hex.length && digits * 4 >= hex.length;
}

/**
 * Why a hand-made reset token can't be used, or null when it can: "not-hex"
 * when it isn't written in hex, "too-weak" when it is but without a
 * generator's mix of digits and letters, or predictably. The caller checks
 * the length first.
 */
export function resetTokenWeakness(token) {
  const hex = resetTokenHexDigits(token);
  if (hex === null) return "not-hex";
  return hasGeneratorMix(hex) && isResetTokenUnpredictable(hex) ? null : "too-weak";
}
