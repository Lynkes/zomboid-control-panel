import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  RESET_TOKEN_MIN_DISTINCT_CHARS,
  RESET_TOKEN_MIN_UNPREDICTABLE_CHARS,
  countUnpredictableChars,
  decodeResetTokenFile,
  isResetTokenUnpredictable,
  isWellKnownResetToken,
  resetTokenHexDigits,
  resetTokenReadsAsText,
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

// Round 3 of the A2 verification: hex is also what every text-to-hex tool
// writes, so a phrase run through xxd -p or .hex() passed the shape and
// pattern checks, and so did the hash of bash's $RANDOM (`echo $RANDOM |
// md5sum`, 32,768 possible tokens), the hash of a common word and the
// UUIDs printed as examples. A stranger who guessed any of them could reset
// the admin password.
const hexOf = (text, encoding = "utf8") => Buffer.from(text, encoding).toString("hex");
const bytePairs = (hex) => hex.match(/../g).join("-");
const digest = (algorithm, input) => crypto.createHash(algorithm).update(input).digest("hex");

describe("reset-token: text written as hex", () => {
  it.each([
    ["xxd -p (with its line break)", hexOf("zomboid-control-panel-reset-token\n")],
    ["Python's .encode().hex()", hexOf("zomboid-control-panel-reset-token")],
    ["PowerShell's [Convert]::ToHexString", hexOf("ZomboidPanelRecovery2026").toUpperCase()],
    ["PowerShell's BitConverter, bytes joined by dashes", bytePairs(hexOf("ZomboidPanelRecovery2026").toUpperCase())],
    ["UTF-16LE (Python's .encode('utf-16-le').hex())", hexOf("zomboid-panel-reset", "utf16le")],
    ["UTF-16 with its byte order mark (.encode('utf-16'))", `fffe${hexOf("zomboid-panel-reset", "utf16le")}`],
    ["UTF-16BE", hexOf("zomboid-panel-reset", "utf16le").match(/(..)(..)/g).map((unit) => unit.slice(2) + unit.slice(0, 2)).join("")],
    ["BitConverter of [Text.Encoding]::Unicode", bytePairs(hexOf("ResetMyPanel!", "utf16le").toUpperCase())],
    ["a digit added in front", `a${hexOf("correct horse battery staple")}`],
    ["the first digit left off", hexOf("correct horse battery staple").slice(1)],
    ["cut to 32 characters", hexOf("my zomboid server reset token").slice(0, 32)],
    ["a short phrase", hexOf("Kentucky1993Knox")],
    ["a date", hexOf("2026-10-05 08:45:00 reset")],
    ["Cyrillic in UTF-8", hexOf("сброс пароля панели зомбоид")],
    ["Cyrillic in UTF-16LE", hexOf("пароль зомбоид", "utf16le")],
    ["Chinese in UTF-8", hexOf("重置僵尸毁灭工程面板密码令牌")],
    ["Arabic in UTF-8", hexOf("إعادة تعيين كلمة المرور")],
    ["accented Latin in UTF-8", hexOf("réinitialisé élément")],
  ])("refuses %s", (_label, token) => {
    expect(token.replaceAll("-", "").length).toBeGreaterThanOrEqual(32);
    expect(resetTokenReadsAsText(token)).toBe(true);
    expect(resetTokenWeakness(token)).toBe("hex-text");
  });

  it("doesn't read random hex as text", () => {
    for (const token of [...sample("text-hex48", HEX, 48, 20000), ...sample("text-hex64", HEX, 64, 2000)]) {
      expect(resetTokenReadsAsText(token)).toBe(false);
    }
  });
});

describe("reset-token: well-known values", () => {
  it("refuses every hash of bash's $RANDOM, `echo $RANDOM | md5sum | head -c 32`", () => {
    const accepted = [];
    for (let n = 0; n < 32768; n++) {
      const token = digest("md5", `${n}\n`);
      if (resetTokenWeakness(token) === null) accepted.push(token);
    }
    expect(accepted).toEqual([]);
  });

  it.each([
    ["md5sum", "md5", "12345\n", 32],
    ["sha1sum, whole", "sha1", "12345\n", 40],
    ["sha1sum | head -c 32", "sha1", "12345\n", 32],
    ["sha256sum, whole", "sha256", "31337\n", 64],
    ["sha256sum | head -c 48", "sha256", "31337\n", 48],
    ["sha512sum | head -c 48", "sha512", "4242\n", 48],
    ["echo -n $RANDOM | md5sum", "md5", "777", 32],
    ["printf $RANDOM | sha256sum | head -c 32", "sha256", "32767", 32],
  ])("refuses a hash of $RANDOM: %s", (_label, algorithm, input, length) => {
    const token = digest(algorithm, input).slice(0, length);
    expect(isWellKnownResetToken(token)).toBe(true);
    expect(isWellKnownResetToken(token.toUpperCase())).toBe(true);
    expect(resetTokenWeakness(token)).toBe("well-known");
  });

  it.each([
    ["md5 of nothing", "md5", ""],
    ["md5 of a line break (echo | md5sum)", "md5", "\n"],
    ["sha1 of nothing", "sha1", ""],
    ["sha256 of nothing", "sha256", ""],
    ["sha512 of nothing", "sha512", ""],
    ["echo password | md5sum", "md5", "password\n"],
    ["md5 of Password", "md5", "Password"],
    ["echo changeme | sha256sum", "sha256", "changeme\n"],
    ["echo zomboid | sha1sum", "sha1", "zomboid\n"],
    ["sha256 of admin", "sha256", "admin"],
    ["md5 of secret", "md5", "secret"],
    ["echo reset-token | md5sum", "md5", "reset-token\n"],
    ["md5 of token", "md5", "token"],
  ])("refuses the %s", (_label, algorithm, input) => {
    const token = digest(algorithm, input);
    expect(isWellKnownResetToken(token)).toBe(true);
    expect(isWellKnownResetToken(token.slice(0, 32))).toBe(true);
    expect(resetTokenWeakness(token)).toBe("well-known");
  });

  it.each([
    "123e4567-e89b-12d3-a456-426614174000",
    "550E8400-E29B-41D4-A716-446655440000",
    "f81d4fae7dec11d0a76500a0c91e6bf6",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
    "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
    "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
    "5df41881-3aed-3515-88a7-2f4a814cf09e",
    "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  ])("refuses the example UUID %s", (uuid) => {
    expect(isWellKnownResetToken(uuid)).toBe(true);
    expect(resetTokenWeakness(uuid)).toBe("well-known");
  });

  it("refuses the nil and max UUIDs", () => {
    for (const uuid of ["00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"]) {
      expect(isWellKnownResetToken(uuid)).toBe(true);
      expect(resetTokenWeakness(uuid)).not.toBeNull();
    }
  });

  it("matches the whole hash or a prefix of 32 characters or more, and nothing else", () => {
    const hash = digest("sha256", "12345\n");
    expect(isWellKnownResetToken(hash.slice(0, 31))).toBe(false);
    expect(isWellKnownResetToken(`${hash.slice(0, 31)}${hash[31] === "0" ? "1" : "0"}`)).toBe(false);
    expect(isWellKnownResetToken(`${hash}0`)).toBe(false);
    for (const token of sample("known-hex32", HEX, 32, 5000)) expect(isWellKnownResetToken(token)).toBe(false);
  });

  // The 262,000-odd hashes take about 200 ms to work out, once; the routes
  // await this so the event loop keeps turning meanwhile.
  it("works the hashes out a slice at a time, letting other callbacks run", async () => {
    vi.resetModules();
    const fresh = await import("../utils/resetTokenStrength.js");
    let ticks = 0;
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    await fresh.prepareResetTokenChecks();
    running = false;
    expect(ticks).toBeGreaterThan(20);
    expect(fresh.isWellKnownResetToken(digest("md5", "4096\n"))).toBe(true);
  });
});

// Round 3 of the A2 verification: the natural way to write the file on
// Windows, `openssl rand -hex 24 > data\reset-token.txt` in Windows
// PowerShell, writes UTF-16 with a byte order mark; read as UTF-8 that was
// refused as "not hex".
describe("reading data/reset-token.txt", () => {
  const token = "3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59";
  const utf16le = (text) => Buffer.from(text, "utf16le");
  it.each([
    ["a trailing line break", Buffer.from(`${token}\n`)],
    ["a Windows line break", Buffer.from(`${token}\r\n`)],
    ["no line break", Buffer.from(token)],
    ["UTF-8 with a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${token}\r\n`)])],
    ["UTF-16LE with a byte order mark (Windows PowerShell's > and Out-File)", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(`${token}\r\n`)])],
    ["UTF-16BE with a byte order mark", Buffer.concat([Buffer.from([0xfe, 0xff]), utf16le(`${token}\r\n`).swap16()])],
    ["UTF-16LE cut off by a byte", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(`${token}\n`), Buffer.from([0x20])])],
  ])("reads the token from a file with %s", (_label, bytes) => {
    expect(decodeResetTokenFile(bytes)).toBe(token);
  });
});
