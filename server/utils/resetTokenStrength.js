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
 *
 * SECURITY (2026-10-05, A2): round 3 of the verification. Hex is also what
 * every text-to-hex tool writes, and some generator output comes from so
 * few inputs that it's on any attacker's list; both passed, and a stranger
 * who guessed the phrase or the hash reset the admin password. So a token
 * whose hex reads as text (resetTokenReadsAsText()) or is a well-known
 * value (isWellKnownResetToken()) is refused too. Random hex reads as text
 * now and then, about 36 times in a million for 32 characters or a UUID
 * and once in a few million for 48; the well-known values never come up by
 * chance. Rounds 4 to 6 of the verification found more of both that
 * passed (resetTokenReadsAsText(), isWellKnownResetToken()); all told, of
 * 41 million random tokens of each kind, about 1 in 13,000 of 32
 * characters is refused, 1 in 15,000 UUIDs and 1 in 1.5 million of 48.
 * These checks catch the common mistakes, not every guessable value (see
 * resetTokenReadsAsText()), which is why the docs say the token must come
 * from one of the commands they give.
 */

import crypto from "crypto";
import { isCommonCjkChar } from "./resetTokenCjkChars.js";

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

// SECURITY (2026-10-05, A2): round 3 of the verification. Hex is what a
// generator writes, but also what every text-to-hex tool writes: xxd -p,
// Python's .encode().hex(), PowerShell's [Convert]::ToHexString or
// [BitConverter]::ToString (bytes joined by dashes), the UTF-16 of
// [Text.Encoding]::Unicode, an online converter. A phrase written that way
// has a generator's mix of digits and letters and none of the patterns
// above, so hex("zomboid-control-panel-reset-token") passed, and a
// stranger who guessed the phrase reset the admin password with it. So the
// hex digits, without the dashes, are decoded -- from the first digit, and
// from the second in case one was added or lost -- and a token is refused
// when the bytes read as text:
//   - nine in ten of them printable ASCII (tabs and line breaks included);
//   - or UTF-8 text all through, with at least one character beyond ASCII
//     (Cyrillic, Greek, Arabic, Chinese, accented letters, curly quotes,
//     emoji...), the last one allowed to be cut off;
//   - or nine in ten of their 16-bit units, in either byte order, printable
//     ASCII, in a script's block (UTF16_TEXT_RANGES) or half of an emoji;
//   - or nine in ten of them Chinese, Japanese or Korean in everyday use
//     (isCjkTextUnit());
//   - or a non-Latin alphabet in a single-byte code page all through
//     (isCodePageText()), line breaks at the end aside;
//   - or everyday Chinese in GBK or Big5 all through
//     (isDoubleByteCodePageText()), line breaks at the end aside;
//   - or nine in ten of their 32-bit units, in either byte order,
//     characters (isMostlyUtf32Text()).
// Random bytes are printable ASCII 98 times in 256, so of a million random
// tokens of 32 hex characters about 40 read as text, and about as many of a
// million UUIDs, on top of the refusals above; of 48, one in a few million
// (the panel's own button draws again). What isn't looked for, because
// random bytes look like it too often:
//   - UTF-16 Chinese, Japanese or Korean with characters beyond the
//     everyday ones for more than a tenth of it (殭, the first character of
//     the traditional Chinese for "zombie", is one);
//   - a single-byte code page with Latin letters: Latin-1 or Windows-1252
//     (Python's .encode('latin-1'), Windows PowerShell's
//     [Text.Encoding]::Default) with accented letters for more than a tenth
//     of it, or Cyrillic, Greek, Hebrew or Arabic in their Windows code
//     pages or KOI8 with Latin letters or symbols among them. Those letters
//     are a quarter of all byte values: counting even two of them as text,
//     with every other byte printable ASCII, refuses about 35 more random
//     tokens of 32 hex characters in a million, doubling the refusals for
//     text;
//   - Thai in its code page (TIS-620, Windows-874), whose letters take up
//     most of the bytes from A1 to EF;
//   - Chinese in GBK or Big5 with Latin letters or characters beyond the
//     everyday ones among it, for the same reasons.
//
// SECURITY (2026-10-05, A2): round 6 of the verification. And that is
// where this stops. Every round found text in one more encoding, there is
// always another (Japanese in Shift_JIS, EBCDIC, text scrambled or hashed
// before it was written as hex), and every reading added refuses a little
// more of what generators write. These readings catch the usual ways of
// writing text as hex; isWellKnownResetToken() catches the usual hashes
// and example UUIDs. Neither can recognise every guessable value, so the
// docs say the token has to come from one of the commands they give.
const TEXT_SHARE = 0.9;

function isAsciiTextByte(byte) {
  return (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// How many bytes the UTF-8 character at bytes[i] takes when it is a
// printable one beyond ASCII (U+00A0 on, no surrogate or overlong form), -1
// when the bytes end partway through one, and 0 otherwise.
function utf8CharLength(bytes, i) {
  const lead = bytes[i];
  const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (length === 0) return 0;
  let codePoint = lead & (0xff >> (length + 1));
  for (let k = 1; k < length; k++) {
    if (i + k >= bytes.length) return -1;
    if ((bytes[i + k] & 0xc0) !== 0x80) return 0;
    codePoint = (codePoint << 6) | (bytes[i + k] & 0x3f);
  }
  const lowest = [0, 0, 0xa0, 0x800, 0x10000][length];
  if (codePoint < lowest || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return 0;
  return length;
}

function isMostlyAscii(bytes) {
  let text = 0;
  for (const byte of bytes) if (isAsciiTextByte(byte)) text += 1;
  return text >= bytes.length * TEXT_SHARE;
}

// SECURITY (2026-10-05, A2): round 4 of the verification. This wanted two
// characters beyond ASCII, so a phrase with one -- an accented letter, the
// curly apostrophe or dash macOS, iOS and Word type for you, an emoji --
// that wasn't also nine tenths ASCII passed: `echo -n "Zomboid’s reset
// token" | xxd -p`. One is enough when every other byte is printable ASCII
// and every other sequence valid UTF-8; that refuses about 4 more random
// tokens in a million of 32 hex characters or UUIDs, and none of 48.
function isUtf8Text(bytes) {
  let beyondAscii = 0;
  for (let i = 0; i < bytes.length; ) {
    if (isAsciiTextByte(bytes[i])) {
      i += 1;
      continue;
    }
    const length = utf8CharLength(bytes, i);
    if (length === 0) return false;
    beyondAscii += 1;
    if (length === -1) break;
    i += length;
  }
  return beyondAscii >= 1;
}

// SECURITY (2026-10-05, A2): round 4 of the verification. Latin, Greek and
// Cyrillic only let UTF-16 text in Arabic (the panel ships an Arabic
// translation), Hebrew, the Indic scripts, Thai or kana pass. These blocks
// are small: with them, 5.7% of the 16-bit range counts as text, so eight
// random units in eight are about once in ten billion.
//
// SECURITY (2026-10-05, A2): round 5 of the verification. Vietnamese,
// whose letters with two accents are in Latin Extended Additional, and Lao,
// Khmer, Ethiopic (Amharic) and Tibetan were outside these blocks, so their
// UTF-16 hex passed, and a stranger who guessed the phrase reset the admin
// password. Now these too, Myanmar and Georgian, and the symbols, dingbats
// and variation selectors some emoji are made of (☀ ✔ ❤️): 9.0% of the
// 16-bit range, which refuses about one more random token in a few million.
//
// SECURITY (2026-10-05, A2): round 6 of the verification. The other emoji
// and symbols of the 16-bit range were still outside these blocks (⭐ ⬆ ▶
// ◀ ⏰ ⌚ ↔ ™), so a phrase with a few of them passed as UTF-16 hex. Now
// letterlike symbols, arrows, technical symbols, geometric shapes and the
// other symbols and arrows too: 10.2% of the 16-bit range, which refuses
// about one more random token in seven million of 32 hex characters, one
// in ten million UUIDs and none of 48 (172 million of each measured).
const UTF16_TEXT_RANGES = [
  [0x00a0, 0x06ff], // accented Latin, Greek, Cyrillic, Armenian, Hebrew, Arabic, Persian
  [0x0900, 0x10ff], // Devanagari and the other Indic scripts, Sinhala, Thai, Lao, Tibetan, Myanmar, Georgian
  [0x1200, 0x139f], // Ethiopic (Amharic, Tigrinya)
  [0x1780, 0x17ff], // Khmer
  [0x1e00, 0x1fff], // Latin Extended Additional (Vietnamese), Greek Extended
  [0x2000, 0x206f], // dashes, curly quotes and the rest of general punctuation
  [0x2100, 0x214f], // letterlike symbols (™ ℹ)
  [0x2190, 0x21ff], // arrows (↔ ↩)
  [0x2300, 0x23ff], // technical symbols (⌚ ⏰ ⏩ ⏳)
  [0x25a0, 0x25ff], // geometric shapes (▶ ◀ ◼)
  [0x2600, 0x27bf], // symbols and dingbats
  [0x2b00, 0x2bff], // more symbols and arrows (⬆ ⬛ ⭐ ⭕)
  [0x3000, 0x30ff], // CJK punctuation, hiragana, katakana
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // a byte order mark
  [0xff00, 0xffef], // full-width punctuation and letters, half-width kana
];

function isUtf16TextUnit(unit) {
  if (unit < 0x80) return isAsciiTextByte(unit);
  return UTF16_TEXT_RANGES.some(([first, last]) => unit >= first && unit <= last);
}

// SECURITY (2026-10-05, A2): round 5 of the verification. Chinese,
// Japanese and Korean are looked for on their own, and only the characters
// in everyday use (resetTokenCjkChars.js): [Convert]::ToHexString(
// [Text.Encoding]::Unicode.GetBytes("重置密码面板令牌")) passed, and the panel
// ships Chinese translations. With CJK punctuation, kana and full-width
// forms they are 15.6% of the 16-bit range, so counted alongside the
// blocks above, which random units mix freely, they would refuse about 100
// more random tokens of 32 hex characters in a million. Counted on their
// own, as a phrase in these languages is written, they refuse about 4 in a
// million of 32 hex characters, 7 in a million UUIDs and one in a few
// million of 48.
const CJK_TEXT_RANGES = [
  [0x2000, 0x206f], // dashes, curly quotes and the rest of general punctuation
  [0x3000, 0x30ff], // CJK punctuation, hiragana, katakana
  [0xfeff, 0xfeff], // a byte order mark
  [0xff00, 0xffef], // full-width punctuation and letters, half-width kana
];

function isCjkTextUnit(unit) {
  if (unit < 0x80) return isAsciiTextByte(unit);
  return isCommonCjkChar(unit) || CJK_TEXT_RANGES.some(([first, last]) => unit >= first && unit <= last);
}

// SECURITY (2026-10-05, A2): round 5 of the verification. An emoji is two
// 16-bit units, a high surrogate and a low one, so a short phrase with one
// in it was only seven units of text in eight: the UTF-16 hex of "Zomboid
// reset 🔑", the phrase round 4's own tests used, passed. A high surrogate
// for U+1F000 to U+1FBFF, where emoji are, and the low one after it are
// two units of text, and so is the high one alone when the bytes end there.
function isEmojiHighSurrogate(unit) {
  return unit >= 0xd83c && unit <= 0xd83e;
}

function isMostlyUtf16Text(bytes, littleEndian, isTextUnit) {
  const units = Math.floor(bytes.length / 2);
  const unitAt = (i) => (littleEndian ? bytes.readUInt16LE(2 * i) : bytes.readUInt16BE(2 * i));
  let text = 0;
  for (let i = 0; i < units; i++) {
    const unit = unitAt(i);
    if (isEmojiHighSurrogate(unit) && (i + 1 === units || (unitAt(i + 1) >= 0xdc00 && unitAt(i + 1) <= 0xdfff))) {
      text += i + 1 === units ? 1 : 2;
      i += 1;
    } else if (isTextUnit(unit)) {
      text += 1;
    }
  }
  return units > 0 && text >= units * TEXT_SHARE;
}

// SECURITY (2026-10-05, A2): round 5 of the verification. A phrase in a
// single-byte code page passed too: Cyrillic in Windows-1251, which is what
// Windows PowerShell 5.1's [Text.Encoding]::Default writes on a Russian or
// Ukrainian Windows (the panel ships a Ukrainian translation), or in KOI8-R
// or KOI8-U; Greek in Windows-1253, Hebrew in Windows-1255, Arabic in
// Windows-1256. Their letters are the bytes from C0 to FF, and the
// Cyrillic ones beyond the Russian alphabet (Ё Є І Ї Ґ Ў) a few from A1 to
// BF. So bytes that are all such letters, spaces, digits or everyday
// punctuation, letters for at least half of them, are refused: about 1
// random token of 32 hex characters in a million, half that of UUIDs, and
// none of 48 measured. Latin letters among them can't be allowed: with
// them, two random bytes in three would count.
const CODE_PAGE_LETTERS_BELOW_C0 = new Set([
  0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xaa, 0xad, 0xaf, 0xb2, 0xb3, 0xb4, 0xb6, 0xb7, 0xb8, 0xba, 0xbd, 0xbf,
]);
const CODE_PAGE_TEXT_BYTES = new Set(Array.from(" 0123456789-_.,!?'", (char) => char.charCodeAt(0)));

function isCodePageText(bytes) {
  let letters = 0;
  for (const byte of bytes) {
    if (byte >= 0xc0 || CODE_PAGE_LETTERS_BELOW_C0.has(byte)) letters += 1;
    else if (!CODE_PAGE_TEXT_BYTES.has(byte)) return false;
  }
  return letters * 2 >= bytes.length;
}

// SECURITY (2026-10-05, A2): round 6 of the verification. Chinese in the
// Windows code page of a Chinese Windows passed: GBK (cp936) for
// simplified Chinese and Big5 (cp950) for traditional, which is what
// Windows PowerShell 5.1's [Text.Encoding]::Default writes there, and what
// a Chinese text-to-hex site offers; the panel ships both translations.
// Their characters are two bytes each, and the everyday ones are the
// first levels resetTokenCjkChars.js lists, at fixed byte values, so no
// decoder is needed (the packaged builds' Node has none for these): GB
// 2312's level 1 (B0A1 to D7F9) and its punctuation and full-width rows
// (A1A1 to A1FE, A3A1 to A3FE); Big5's level 1 (A440 to C67E) and its
// punctuation and full-width forms (A140 to A3BF). Bytes that are all such
// characters, spaces, digits or everyday punctuation, the characters at
// least half of them, are refused, the last byte allowed to be the first
// half of one. Korean in EUC-KR and kanji in EUC-JP use the bytes of GB
// 2312's level 1, so they are refused too. Random tokens of 32 hex
// characters or UUIDs are that about once in twelve million (Big5 once in
// fifteen million, GBK once in eighty), and none of 48 measured; as with the
// single-byte code pages, Latin letters among them can't be allowed,
// since random bytes are printable ASCII so often that they would be
// several in a million.
const inRange = (value, first, last) => value >= first && value <= last;
const DOUBLE_BYTE_CODE_PAGES = [
  // GBK (cp936)
  (lead, trail) =>
    (inRange(lead, 0xb0, 0xd7) && inRange(trail, 0xa1, lead === 0xd7 ? 0xf9 : 0xfe)) ||
    ((lead === 0xa1 || lead === 0xa3) && inRange(trail, 0xa1, 0xfe)),
  // Big5 (cp950)
  (lead, trail) =>
    inRange(lead * 256 + trail, 0xa140, 0xc67e) &&
    !inRange(lead * 256 + trail, 0xa3c0, 0xa43f) &&
    (inRange(trail, 0x40, 0x7e) || inRange(trail, 0xa1, 0xfe)),
];

function isDoubleByteCodePageText(bytes, isEverydayChar) {
  let charBytes = 0;
  for (let i = 0; i < bytes.length; ) {
    if (CODE_PAGE_TEXT_BYTES.has(bytes[i])) {
      i += 1;
    } else if (i + 1 < bytes.length && isEverydayChar(bytes[i], bytes[i + 1])) {
      charBytes += 2;
      i += 2;
    } else if (i + 1 === bytes.length && (isEverydayChar(bytes[i], 0x40) || isEverydayChar(bytes[i], 0xa1))) {
      charBytes += 1;
      i += 1;
    } else {
      return false;
    }
  }
  return charBytes * 2 >= bytes.length;
}

// SECURITY (2026-10-05, A2): round 7 of the verification. The two
// code-page readings above allow nothing but spaces, digits and everyday
// punctuation beside the characters, so the line break a tool adds at the
// end hid the text from them. `echo 重置密码面板令牌 | iconv -t gbk | xxd -p`
// passed, and so did Windows PowerShell 5.1's Set-Content or Out-File (GBK
// or Big5 on a Chinese Windows, Windows-1251 on a Russian one, CRLF at the
// end) read back with [BitConverter]::ToString; a stranger who guessed the
// phrase reset the admin password. The other readings count line breaks as
// text, so these two now read the bytes without the ones at the end. Random
// bytes seldom end in one: of 300 million random tokens of each kind, that
// refused 4 more of 32 hex characters, 2 more UUIDs and none of 48.
// Allowing line breaks and tabs anywhere, for a phrase on more than one
// line, would have refused about one more in 1.3 million of 32 hex
// characters.
function withoutTrailingLineBreaks(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
  return bytes.subarray(0, end);
}

function isCodePageTextLine(bytes) {
  const line = withoutTrailingLineBreaks(bytes);
  if (line.length === 0) return false;
  return isCodePageText(line) || DOUBLE_BYTE_CODE_PAGES.some((isEverydayChar) => isDoubleByteCodePageText(line, isEverydayChar));
}

// SECURITY (2026-10-05, A2): round 6 of the verification. UTF-32 (Python's
// .encode('utf-32'), [Text.Encoding]::UTF32) takes four bytes a character,
// three of them zero for an ASCII one, so none of the readings above saw
// text in it: the docs' own example of a refused phrase,
// zomboid-control-panel-reset-token, passed that way. Nine in ten of its
// 32-bit units, in either byte order, are characters: printable ASCII or a
// code point from U+00A0 to U+10FFFF that isn't half of a surrogate pair.
// Random units are one about once in 3,900, so four in four never come up
// (none in 172 million random tokens of each kind). Round 7 of the
// verification: a phrase in Chinese, Japanese or Korean with its first
// byte or digit lost no longer reads as text, as in UTF-16; that's a typo
// on top of an unusual encoding, and it's left.
function isMostlyUtf32Text(bytes, littleEndian) {
  const units = Math.floor(bytes.length / 4);
  let text = 0;
  for (let i = 0; i < units; i++) {
    const unit = littleEndian ? bytes.readUInt32LE(4 * i) : bytes.readUInt32BE(4 * i);
    if (unit < 0xa0 ? isAsciiTextByte(unit) : unit <= 0x10ffff && !inRange(unit, 0xd800, 0xdfff)) text += 1;
  }
  return units > 0 && text >= units * TEXT_SHARE;
}

export function resetTokenReadsAsText(token) {
  const hex = resetTokenHexDigits(token);
  if (hex === null) return false;
  for (const start of [0, 1]) {
    const end = hex.length - ((hex.length - start) % 2);
    const bytes = Buffer.from(hex.slice(start, end), "hex");
    if (bytes.length === 0) continue;
    if (isMostlyAscii(bytes) || isUtf8Text(bytes) || isCodePageTextLine(bytes)) return true;
    for (const littleEndian of [true, false]) {
      if (
        isMostlyUtf16Text(bytes, littleEndian, isUtf16TextUnit) ||
        isMostlyUtf16Text(bytes, littleEndian, isCjkTextUnit) ||
        isMostlyUtf32Text(bytes, littleEndian)
      ) {
        return true;
      }
    }
  }
  return false;
}

// SECURITY (2026-10-05, A2): round 3 of the verification, too. Some hex
// does come from a generator, but from so few inputs that it's the first
// thing an attacker tries:
//   - a hash of bash's $RANDOM, a number from 0 to 32767: `echo $RANDOM |
//     md5sum | head -c 32`, or sha1sum, sha224sum, sha256sum, sha384sum or
//     sha512sum, echo -n or printf, the whole hash or its first 32
//     characters or more; or of cmd's %RANDOM%, the same numbers, written
//     to a file and hashed with certutil -hashfile or Get-FileHash;
//   - a hash of nothing, of a line break, or of a word anyone would try,
//     as typed, capitalized or in capitals;
//   - the nil UUID and the UUIDs printed as examples: in RFC 4122 and RFC
//     9562 (their namespaces and test vectors), on Wikipedia, in Python's
//     uuid docs and Swagger's, in PostgreSQL's, SQL Server's and MySQL's.
// A random token is one of these about as often as it guesses a hash, so
// they cost no legitimate token anything.
const WELL_KNOWN_UUIDS = new Set(
  [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    // RFC 4122's and RFC 9562's namespaces, and RFC 4122's examples.
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
    "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
    "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
    "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
    "e902893a-9d22-3c7e-a7b8-d6e313b71d9f",
    "3d813cbb-47fb-32ba-91df-831e1593ac29",
    // RFC 9562's test vectors, versions 1, 3 to 7 and 8 (twice).
    "c232ab00-9414-11ec-b3c8-9f6bdeced846",
    "5df41881-3aed-3515-88a7-2f4a814cf09e",
    "919108f7-52d1-4320-9bac-f847db4148a8",
    "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    "1ec9414c-232a-6b00-b3c8-9f6bdeced846",
    "017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
    "2489e9ad-2ee2-8e00-8ec9-32d5f69181c0",
    "5c146b14-3c52-8afd-938a-375d0df1fbf6",
    // Wikipedia's, and the ones copied from page to page.
    "123e4567-e89b-12d3-a456-426614174000",
    "550e8400-e29b-41d4-a716-446655440000",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "de305d54-75b4-431b-adb2-eb6b9e546014",
    // Python's uuid docs, and Swagger's default example.
    "a8098c1a-f86e-11da-bd1a-00112444be1e",
    "6fa459ea-ee8a-3ca4-894e-db77e160355e",
    "16fd2706-8baf-433b-82eb-8c7fada847da",
    "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    // PostgreSQL's uuid type, SQL Server's uniqueidentifier and MySQL's
    // UUID() docs (round 4 of the verification).
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "6f9619ff-8b86-d011-b42d-00c04fc964ff",
    "6ccd780c-baba-1026-9564-5b8c656024db",
  ].map((uuid) => uuid.replaceAll("-", "")),
);

const COMMON_WORDS = [
  "",
  "password",
  "admin",
  "administrator",
  "root",
  "changeme",
  "zomboid",
  "projectzomboid",
  "project zomboid",
  "panel",
  "server",
  "reset",
  "resettoken",
  "reset-token",
  "reset token",
  "token",
  "recovery",
  "secret",
  "test",
  "letmein",
  "welcome",
  "qwerty",
  "hello",
  "default",
  "guest",
  "user",
  "123456",
  "12345678",
  "123456789",
  // Round 4 of the verification: with a digit or two added.
  "password1",
  "password123",
  "passw0rd",
  "p@ssw0rd",
  "admin1",
  "admin123",
  "changeme1",
  "changeme123",
  "qwerty123",
  "abc123",
  "zomboid1",
  "zomboid123",
];

// How each input gets hashed: the algorithm, and what follows the number or
// word. echo -n or printf, and echo, piped to md5sum ... sha512sum: nothing,
// or a line break. SECURITY (2026-10-05, A2): round 4 of the verification
// added sha224sum and sha384sum, and cmd's `echo %RANDOM%>file` or `echo
// %RANDOM% > file` hashed with certutil -hashfile (SHA1 unless told
// otherwise) or Get-FileHash (SHA256): a Windows line break, after a space
// in the second form.
const KNOWN_HASH_FORMS = [
  ...["md5", "sha1", "sha224", "sha256", "sha384", "sha512"].flatMap((algorithm) => [
    [algorithm, ""],
    [algorithm, "\n"],
  ]),
  ...["md5", "sha1", "sha256"].flatMap((algorithm) => [
    [algorithm, "\r\n"],
    [algorithm, " \r\n"],
  ]),
];

// Every hash of those inputs in each of those forms, kept as the first 32
// bits of each (knownHashDigest() says which input and form an entry is)
// and grouped by their first 16 bits, so a lookup hashes again only the
// few entries that share a token's first 32: under 6 MB with the inputs,
// where the hashes as strings would take several times that.
const KNOWN_HASH_SLICE = 2048;
let knownHashInputs = null;
let knownHashes = null;

const hexDigest =
  typeof crypto.hash === "function"
    ? (algorithm, input) => crypto.hash(algorithm, input)
    : (algorithm, input) => crypto.createHash(algorithm).update(input).digest("hex");

function knownHashDigest(entry) {
  const [algorithm, ending] = KNOWN_HASH_FORMS[entry % KNOWN_HASH_FORMS.length];
  return hexDigest(algorithm, knownHashInputs[Math.floor(entry / KNOWN_HASH_FORMS.length)] + ending);
}

// Works out up to `count` more of the hashes, and groups them once they're
// all there. Whether they are.
function fillKnownHashes(count) {
  if (!knownHashes) {
    const capitalized = COMMON_WORDS.map((word) => word.charAt(0).toUpperCase() + word.slice(1));
    const capitals = COMMON_WORDS.map((word) => word.toUpperCase());
    knownHashInputs = [
      ...Array.from({ length: 32768 }, (_, n) => String(n)),
      ...new Set([...COMMON_WORDS, ...capitalized, ...capitals]),
    ];
    knownHashes = {
      prefixes: new Uint32Array(knownHashInputs.length * KNOWN_HASH_FORMS.length),
      filled: 0,
      starts: null,
      order: null,
    };
  }
  const { prefixes } = knownHashes;
  const end = Math.min(prefixes.length, knownHashes.filled + count);
  for (let entry = knownHashes.filled; entry < end; entry++) {
    prefixes[entry] = parseInt(knownHashDigest(entry).slice(0, 8), 16);
  }
  knownHashes.filled = end;
  if (end === prefixes.length && !knownHashes.order) {
    // A counting sort on the first 16 bits: entries starts[b] to
    // starts[b + 1] of `order` are the ones whose hash begins with b.
    const starts = new Uint32Array(65537);
    for (const prefix of prefixes) starts[(prefix >>> 16) + 1] += 1;
    for (let b = 1; b < starts.length; b++) starts[b] += starts[b - 1];
    const next = starts.slice(0, 65536);
    const order = new Uint32Array(prefixes.length);
    for (let entry = 0; entry < prefixes.length; entry++) order[next[prefixes[entry] >>> 16]++] = entry;
    knownHashes.starts = starts;
    knownHashes.order = order;
  }
  return knownHashes.order !== null;
}

let preparing = null;

/**
 * Works out the hashes isWellKnownResetToken() needs, a slice at a time so
 * the event loop keeps turning: about 590,000 of them, half a second of
 * work in slices of a few ms, once per process. Without it the first check
 * does it all in one go.
 *
 * SECURITY (2026-10-05, A2): round 4 of the verification. Callers that ask
 * while it's under way wait for the same work; each used to run its own
 * slices, and Node runs every queued setImmediate callback in one go, so
 * 50 requests arriving together held up the event loop for 50 slices at a
 * time.
 *
 * SECURITY (2026-10-05, A2): round 5 of the verification. index.js starts
 * it as soon as the panel is listening, so a reset request seldom has to
 * wait for it: the first one used to, most of a second, and the ones that
 * queued up behind it all resumed in the same turn of the event loop.
 */
export function prepareResetTokenChecks() {
  preparing ??= (async () => {
    while (!fillKnownHashes(KNOWN_HASH_SLICE)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  return preparing;
}

function isKnownHash(hex) {
  const digits = hex.toLowerCase();
  if (digits.length < 32) return false;
  fillKnownHashes(Infinity);
  const { prefixes, starts, order } = knownHashes;
  const prefix = parseInt(digits.slice(0, 8), 16);
  for (let i = starts[prefix >>> 16]; i < starts[(prefix >>> 16) + 1]; i++) {
    const entry = order[i];
    if (prefixes[entry] === prefix && knownHashDigest(entry).startsWith(digits)) return true;
  }
  return false;
}

export function isWellKnownResetToken(token) {
  const hex = resetTokenHexDigits(token);
  if (hex === null) return false;
  return WELL_KNOWN_UUIDS.has(hex.toLowerCase()) || isKnownHash(hex);
}

/**
 * Why a hand-made reset token can't be used, or null when it can: "not-hex"
 * when it isn't written in hex; "too-weak" when it is but without a
 * generator's mix of digits and letters, or predictably; "hex-text" when its
 * hex reads as text; "well-known" when it is a hash of $RANDOM or of a
 * common word, or an example UUID. The caller checks the length first, and
 * awaits prepareResetTokenChecks() so the last check doesn't hold up the
 * event loop.
 */
export function resetTokenWeakness(token) {
  const hex = resetTokenHexDigits(token);
  if (hex === null) return "not-hex";
  if (!hasGeneratorMix(hex) || !isResetTokenUnpredictable(hex)) return "too-weak";
  if (resetTokenReadsAsText(hex)) return "hex-text";
  if (isWellKnownResetToken(hex)) return "well-known";
  return null;
}

/**
 * The token in data/reset-token.txt, from the file's bytes. Line breaks
 * and spaces around it don't count, nor does a byte order mark: UTF-8's
 * (Notepad, PowerShell's -Encoding utf8) or UTF-16's, which Windows
 * PowerShell 5.1 writes for `openssl rand -hex 24 > data\reset-token.txt`
 * and Out-File, so the token reads the same whichever wrote it.
 *
 * SECURITY (2026-10-05, A2): round 4 of the verification. And UTF-32's,
 * which Set-Content -Encoding utf32 writes: its little-endian mark starts
 * like UTF-16's, so it was read as UTF-16 and refused as "not hex".
 */
export function decodeResetTokenFile(bytes) {
  const evenEnd = bytes.length - (bytes.length % 2);
  let text;
  const utf32 =
    bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0
      ? "le"
      : bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff
        ? "be"
        : null;
  if (utf32) {
    const chars = [];
    for (let i = 4; i + 4 <= bytes.length; i += 4) {
      const codePoint = utf32 === "le" ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i);
      // Not a character at all: anything that isn't hex is refused anyway.
      chars.push(codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "?");
    }
    text = chars.join("");
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2, evenEnd).toString("utf16le");
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = Buffer.from(bytes.subarray(2, evenEnd)).swap16().toString("utf16le");
  } else {
    text = bytes.toString("utf8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trim();
}
