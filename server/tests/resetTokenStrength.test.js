import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  RESET_TOKEN_MIN_DISTINCT_CHARS,
  RESET_TOKEN_MIN_UNPREDICTABLE_CHARS,
  countUnpredictableChars,
  isResetTokenUnpredictable,
  resetTokenHexDigits,
  resetTokenWeakness,
} from "../utils/resetTokenStrength.js";

// Security sweep 2026-10-05, A2: once wrong reset tokens stopped deleting
// data/reset-token.txt, the token itself is what keeps online guessing
// infeasible, so a long but predictable one has to be refused. These pin
// both sides: what a person might type is refused, and what any password
// generator produces is accepted. The random samples come from a fixed
// seed, so this file can't flake.

function* seededBytes(label) {
  for (let i = 0; ; i++) {
    yield* crypto.createHash("sha256").update(`${label}:${i}`).digest();
  }
}

function sample(label, alphabet, length, count) {
  const bytes = seededBytes(label);
  const tokens = [];
  for (let n = 0; n < count; n++) {
    let token = "";
    for (let i = 0; i < length; i++) token += alphabet[bytes.next().value % alphabet.length];
    tokens.push(token);
  }
  return tokens;
}

const HEX = "0123456789abcdef";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PRINTABLE = `${ALNUM}!@#$%^&*()-_=+[]{};:,.<>/?~`;

describe("reset-token strength", () => {
  it.each([
    ["one character repeated", "a".repeat(40)],
    ["the alphabet", "abcdefghijklmnopqrstuvwxyz012345"],
    ["counting down", "zyxwvutsrqponmlkjihgfedcba9876543210"],
    ["hex digits twice", "0123456789abcdef0123456789abcdef"],
    ["keyboard rows", "qwertyuiopasdfghjklzxcvbnm123456"],
    ["a word repeated", "passwordpasswordpasswordpassword"],
    ["a word repeated, then a run", "changemechangemechangeme12345678"],
    ["a short pattern repeated", "abababababababababababababababab"],
    ["runs of one character each", "aaaabbbbccccddddeeeeffffgggghhhh"],
    ["a classic repeated", "Tr0ub4dor&3Tr0ub4dor&3Tr0ub4dor&"],
    ["hex words repeated", "deadbeefdeadbeefdeadbeefdeadbeef"],
  ])("refuses %s", (_label, token) => {
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(isResetTokenUnpredictable(token)).toBe(false);
  });

  // Round 1 of the A2 verification accepted all of these: steps were only
  // compared case by case and one code point at a time, the keyboard only
  // along its rows, and only between neighbouring characters.
  it.each([
    ["keyboard columns", "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9"],
    ["keyboard columns, upwards", "zaq1xsw2cde3vfr4bgt5nhy6mju7,ki8"],
    ["keyboard columns with Shift", "!QAZ@WSX#EDC$RFV%TGB^YHN&UJM*IK<(OL>"],
    ["keyboard columns, no digits", "qazwsxedcrfvtgbyhnujmikolp1234567"],
    ["keyboard diagonals", "q1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm"],
    ["every other key", "qetuoadgjlzcbm13579wryipsfhkxvn24680"],
    ["the alphabet, alternating case", "aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpP"],
    ["two runs interleaved", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"],
    ["two runs interleaved, one counting down", "a0b9c8d7e6f5g4h3i2j1k0l9m8n7o6p5"],
    ["three runs interleaved", "a1!b2@c3#d4$e5%f6^g7&h8*i9(j0)k1!"],
    ["every second letter", "acegikmoqsuwyACEGIKMOQSUWY024680"],
    ["a mirrored alphabet", "azbycxdwevfugthsirjqkplomn0918273645"],
    ["pairs counting up", "00112233445566778899aabbccddeeff"],
    ["two characters", "0101010110101010010101011010101001010101"],
  ])("refuses %s", (_label, token) => {
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(isResetTokenUnpredictable(token)).toBe(false);
  });

  it.each([
    ["32 hex characters", sample("hex32", HEX, 32, 2000)],
    ["32 upper-case hex characters", sample("HEX32", HEX.toUpperCase(), 32, 2000)],
    ["48 hex characters (the panel's own button)", sample("hex48", HEX, 48, 2000)],
    ["32 base64 characters", sample("b64", BASE64, 32, 2000)],
    ["32 base64url characters", sample("b64url", BASE64URL, 32, 2000)],
    ["32 letters and digits", sample("alnum", ALNUM, 32, 2000)],
    ["32 letters, digits and symbols", sample("printable", PRINTABLE, 32, 2000)],
  ])("accepts every one of 2000 seeded random tokens of %s", (_label, tokens) => {
    const refused = tokens.filter((token) => !isResetTokenUnpredictable(token));
    expect(refused).toEqual([]);
  });

  it("accepts what the docs suggest and what the panel writes", () => {
    for (let i = 0; i < 200; i++) {
      expect(resetTokenWeakness(crypto.randomBytes(24).toString("hex"))).toBeNull();
      expect(resetTokenWeakness(crypto.randomBytes(24).toString("hex").toUpperCase())).toBeNull();
      expect(resetTokenWeakness(crypto.randomUUID())).toBeNull();
    }
  });

  it("counts a stretch seen before as predictable after its first two characters", () => {
    expect(countUnpredictableChars("changeme")).toBe(8);
    expect(countUnpredictableChars("changemechangeme")).toBe(10);
    expect(RESET_TOKEN_MIN_UNPREDICTABLE_CHARS).toBe(20);
  });

  it("ignores case, and needs enough different characters", () => {
    expect(countUnpredictableChars("PasswordpASSWORD")).toBe(countUnpredictableChars("passwordpassword"));
    expect(RESET_TOKEN_MIN_DISTINCT_CHARS).toBe(8);
    // 32 characters, every one unpredictable, but only 7 different ones.
    const sevenChars = sample("seven", "ap7xj3]", 32, 200).find(
      (token) => countUnpredictableChars(token) >= RESET_TOKEN_MIN_UNPREDICTABLE_CHARS,
    );
    expect(sevenChars).toBeDefined();
    expect(isResetTokenUnpredictable(sevenChars)).toBe(false);
  });
});

// Round 2 of the A2 verification: the pattern check can't see meaning, so
// panel-themed phrases, sentences, word lists, the digits of pi and e and a
// symbol template all passed it, and with nothing deleting the file a
// remote stranger could guess the weakest of them. A hand-made token now
// has to be what a generator writes: hex.
describe("reset-token shape", () => {
  it.each([
    "zomboid-control-panel-reset-token",
    "ZomboidControlPanelResetToken2026",
    "this is my reset token for the panel",
    "the-panel-password-is-gone-help-me",
    "the quick brown fox jumps over the lazy dog",
    "Twinkle, twinkle, little star, how I wonder what you are",
    "one two three four five six seven eight nine ten",
    "MondayTuesdayWednesdayThursdayFriday",
    "JanuaryFebruaryMarchAprilMayJuneJuly",
    "redorangeyellowgreenblueindigoviolet",
    "3.14159265358979323846264338327950",
    "2.71828182845904523536028747135266",
    "Aa1!Bb2@Cc3#Dd4$Ee5%Ff6^Gg7&Hh8*",
    // Base64 or letters and digits from a generator: random, but the same
    // alphabet spells every word, so the check couldn't tell them apart.
    sample("b64-shape", BASE64, 32, 1)[0],
    sample("alnum-shape", ALNUM, 32, 1)[0],
    // Dashes only between groups of hex digits.
    `-${"0f".repeat(20)}`,
    `${"0f".repeat(10)}--${"0f".repeat(10)}`,
  ])("refuses %s as not hex", (token) => {
    expect(resetTokenHexDigits(token)).toBeNull();
    expect(resetTokenWeakness(token)).toBe("not-hex");
  });

  it.each([
    ["the digits of pi", "31415926535897932384626433832795028841971"],
    ["the digits of e", "27182818284590452353602874713526624977572"],
    ["a date and a phone number", "2026100518005550199202610051800555"],
    ["hex words", "deadbeefcafebabefacadedecadebeadfeed"],
    ["hex words and a digit", "deadbeefcafebabefacadedecade1bad"],
    ["hex words with digits for letters", "c0ffeedeadbeefbaddecafbeefcafefacade"],
  ])("refuses %s: hex, but not a generator's mix of digits and letters", (_label, token) => {
    expect(resetTokenHexDigits(token)).toBe(token);
    expect(resetTokenWeakness(token)).toBe("too-weak");
  });

  it("still refuses predictable hex", () => {
    for (const token of ["0123456789abcdef0123456789abcdef", "00112233445566778899aabbccddeeff", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"]) {
      expect(resetTokenWeakness(token)).toBe("too-weak");
    }
  });

  it("reads hex in dash-separated groups, like a UUID, as its digits", () => {
    const uuid = crypto.randomUUID();
    expect(resetTokenHexDigits(uuid)).toBe(uuid.replaceAll("-", ""));
    expect(resetTokenHexDigits(uuid.toUpperCase())).toBe(uuid.replaceAll("-", "").toUpperCase());
  });

  it.each([
    ["32 hex characters", sample("shape-hex32", HEX, 32, 2000), 3],
    ["32 upper-case hex characters", sample("shape-HEX32", HEX.toUpperCase(), 32, 2000), 3],
    ["48 hex characters (the panel's own button)", sample("shape-hex48", HEX, 48, 2000), 0],
  ])("accepts seeded random tokens of %s", (_label, tokens, allowedRefusals) => {
    const refused = tokens.filter((token) => resetTokenWeakness(token) !== null);
    expect(refused.length).toBeLessThanOrEqual(allowedRefusals);
  });

  it("accepts every one of 2000 seeded random UUIDs", () => {
    const bytes = seededBytes("uuid");
    const uuids = Array.from({ length: 2000 }, () => {
      const b = Buffer.from(Array.from({ length: 16 }, () => bytes.next().value));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const hex = b.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
    expect(uuids.filter((uuid) => resetTokenWeakness(uuid) !== null)).toEqual([]);
  });
});
