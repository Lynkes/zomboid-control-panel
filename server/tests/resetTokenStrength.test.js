import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
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
import { COMMON_CJK_FIRST, COMMON_CJK_LAST, isCommonCjkChar } from "../utils/resetTokenCjkChars.js";

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

// Version 4 UUIDs, as uuidgen, New-Guid and Node's randomUUID write them.
function sampleUuids(label, count) {
  const bytes = seededBytes(label);
  return Array.from({ length: count }, () => {
    const b = Buffer.from(Array.from({ length: 16 }, () => bytes.next().value));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}

const HEX = "0123456789abcdef";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PRINTABLE = `${ALNUM}!@#$%^&*()-_=+[]{};:,.<>/?~`;

// Whether this Node can decode the legacy Chinese, Japanese and Korean
// encodings (a full-ICU build can; the packaged builds' can't).
const canDecodeLegacy = (() => {
  try {
    for (const label of ["gb2312", "gbk", "big5", "euc-jp", "euc-kr"]) new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
})();

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

  // Round 6 of the A2 verification: this drew 200 UUIDs and 400 tokens of
  // 48 hex characters without a seed, and about 1 random UUID in 15,000 is
  // refused, so release CI failed about one run in 70.
  it("accepts what the docs suggest and what the panel writes", () => {
    const tokens = [
      ...sample("docs-hex48", HEX, 48, 200),
      ...sample("docs-HEX48", HEX.toUpperCase(), 48, 200),
      ...sampleUuids("docs-uuid", 200),
    ];
    expect(tokens.filter((token) => resetTokenWeakness(token) !== null)).toEqual([]);
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
    const [uuid] = sampleUuids("dash-groups", 1);
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
    const uuids = sampleUuids("uuid", 2000);
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

  // Round 4: UTF-8 with a single character beyond ASCII -- one accented
  // letter, the curly apostrophe or dash macOS, iOS and Word type for you,
  // an emoji -- was neither nine-tenths ASCII nor two characters beyond it,
  // so `echo -n "Zomboid’s reset token" | xxd -p` passed.
  it.each([
    ["one accented letter", hexOf("Passwort zurück")],
    ["one accented letter, upper-case", hexOf("Réinitialisation").toUpperCase()],
    ["one accented letter, BitConverter", bytePairs(hexOf("Passwort zurück").toUpperCase())],
    ["one ñ", hexOf("contraseña olvi")],
    ["one curly apostrophe", hexOf("Zomboid’s reset token")],
    ["one en dash", hexOf("Zomboid – Panel Reset 2026")],
    ["one emoji", hexOf("Zomboid reset 🔑")],
    ["one emoji in a longer phrase", hexOf("My zomboid server 🧟 reset")],
    ["its one emoji cut off at 32 digits", hexOf("Zomboid reset 🔑").slice(0, 32)],
    ["one accented letter, a digit added in front", `7${hexOf("Passwort zurück")}`],
  ])("refuses UTF-8 text with %s", (_label, token) => {
    expect(token.replaceAll("-", "").length).toBeGreaterThanOrEqual(32);
    expect(resetTokenReadsAsText(token)).toBe(true);
    expect(resetTokenWeakness(token)).toBe("hex-text");
  });

  // Round 4: UTF-16 text was looked for in Latin, Greek and Cyrillic only;
  // Arabic (the panel ships an Arabic translation), Hebrew, the Indic
  // scripts, Thai and kana passed.
  const utf16be = (text) => Buffer.from(text, "utf16le").swap16().toString("hex");
  it.each([
    ["Arabic", "إعادة تعيين كلمة المرور للوحة"],
    ["Arabic, short", "كلمة سر اللوحة"],
    ["Persian", "بازنشانی رمز عبور"],
    ["Hebrew", "איפוס סיסמה ללוח"],
    ["Armenian", "գաղտնաբառի վերականգնում"],
    ["Hindi", "पासवर्ड रीसेट करें"],
    ["Thai", "รีเซ็ตรหัสผ่าน"],
    ["katakana", "パスワードリセット"],
    ["hiragana and full-width punctuation", "ぱすわーど、りせっと！"],
  ])("refuses %s as UTF-16 hex, in either byte order", (_label, phrase) => {
    for (const token of [hexOf(phrase, "utf16le"), hexOf(phrase, "utf16le").toUpperCase(), `fffe${hexOf(phrase, "utf16le")}`, utf16be(phrase)]) {
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(resetTokenWeakness(token)).toBe("hex-text");
    }
  });

  // Round 5: Vietnamese (its letters with two accents are in Latin Extended
  // Additional), Lao, Khmer, Ethiopic and Tibetan were outside the blocks
  // looked for; so was every emoji, two 16-bit units, which left a short
  // phrase with one at seven units of text in eight; and Chinese, Japanese
  // and Korean weren't looked for at all. A stranger who guessed the phrase
  // reset the admin password with its UTF-16 hex.
  it.each([
    ["Vietnamese", "Đặt lại mật khẩu bảng điều khiển"],
    ["Vietnamese, short", "Khôi phục mật khẩu"],
    ["one emoji", "Zomboid reset 🔑"],
    ["one emoji, in the middle", "zomboid🧟panel"],
    ["Lao", "ຕັ້ງລະຫັດຜ່ານໃໝ່"],
    ["Khmer", "កំណត់ពាក្យសម្ងាត់ឡើងវិញ"],
    ["Amharic", "የይለፍ ቃል ዳግም ማስጀመሪያ"],
    ["Tibetan", "གསང་ཚིག་བསྐྱར་སྒྲིག"],
    ["Burmese", "စကားဝှက်ပြန်လည်သတ်မှတ်ရန်"],
    ["Georgian", "პაროლის აღდგენა"],
    ["simplified Chinese", "重置密码面板令牌"],
    ["simplified Chinese, longer", "我的僵尸服务器重置"],
    ["traditional Chinese", "重設密碼面板權杖"],
    ["Japanese, kana and kanji", "パスワード再設定"],
    ["Japanese, longer", "管理者パスワード再設定"],
    ["Korean", "비밀번호 재설정 패널"],
    ["Korean, longer", "좀보이드 서버 비밀번호"],
  ])("refuses %s as UTF-16 hex, in either byte order and as BitConverter writes it", (_label, phrase) => {
    const le = hexOf(phrase, "utf16le");
    for (const token of [le, le.toUpperCase(), `fffe${le}`, utf16be(phrase), bytePairs(le.toUpperCase())]) {
      expect(token.replaceAll("-", "").length).toBeGreaterThanOrEqual(32);
      expect(resetTokenWeakness(token)).toBe("hex-text");
    }
  });

  it("refuses UTF-16 hex cut off right after the first half of an emoji", () => {
    const token = hexOf("ResetMe🔑", "utf16le").slice(0, 32);
    expect(token.endsWith("3dd8")).toBe(true);
    expect(resetTokenWeakness(token)).toBe("hex-text");
  });

  // Round 5: a phrase in a single-byte code page: Cyrillic in Windows-1251
  // (Windows PowerShell 5.1's [Text.Encoding]::Default on a Russian or
  // Ukrainian Windows) or KOI8-R, Greek in Windows-1253, Hebrew in
  // Windows-1255.
  const KOI8_LETTERS = "юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ";
  const CP1251_BEYOND_RUSSIAN = { Ё: 0xa8, ё: 0xb8, Є: 0xaa, є: 0xba, І: 0xb2, і: 0xb3, Ї: 0xaf, ї: 0xbf, Ґ: 0xa5, ґ: 0xb4 };
  const singleByteHex = (text, byteOf) =>
    Buffer.from(Array.from(text, (char) => (char.charCodeAt(0) < 0x80 ? char.charCodeAt(0) : byteOf(char)))).toString("hex");
  it.each([
    ["Russian in Windows-1251", singleByteHex("сброс пароля зомбоид", (c) => 0xc0 + c.charCodeAt(0) - 0x410)],
    ["Ukrainian in Windows-1251", singleByteHex("скидання пароля панелі", (c) => CP1251_BEYOND_RUSSIAN[c] ?? 0xc0 + c.charCodeAt(0) - 0x410)],
    ["Ukrainian with an apostrophe", singleByteHex("пам'ять сервера зомбі", (c) => CP1251_BEYOND_RUSSIAN[c] ?? 0xc0 + c.charCodeAt(0) - 0x410)],
    ["Russian in KOI8-R", singleByteHex("сброс пароля панели", (c) => 0xc0 + KOI8_LETTERS.indexOf(c))],
    ["Greek in Windows-1253", singleByteHex("επαναφορά κωδικού", (c) => c.charCodeAt(0) - 0x2d0)],
    ["Hebrew in Windows-1255", singleByteHex("איפוס סיסמה ללוח", (c) => c.charCodeAt(0) - 0x4f0)],
  ])("refuses %s, as hex", (_label, token) => {
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(resetTokenWeakness(token)).toBe("hex-text");
    expect(resetTokenWeakness(token.toUpperCase())).toBe("hex-text");
    expect(resetTokenWeakness(bytePairs(token))).toBe("hex-text");
  });

  // Round 6: UTF-32 is four bytes a character, three of them zero for an
  // ASCII one, so no reading saw text in it, and the docs' own example of a
  // refused phrase passed as [BitConverter]::ToString(
  // [Text.Encoding]::UTF32.GetBytes("zomboid-control-panel-reset-token")).
  const utf32Hex = (text, littleEndian = true) =>
    Buffer.concat(
      Array.from(text, (char) => {
        const unit = Buffer.alloc(4);
        if (littleEndian) unit.writeUInt32LE(char.codePointAt(0));
        else unit.writeUInt32BE(char.codePointAt(0));
        return unit;
      }),
    ).toString("hex");
  it.each([
    ["the docs' example of a refused phrase", "zomboid-control-panel-reset-token"],
    ["an English sentence", "reset the admin password please"],
    ["a phrase with an emoji", "Zomboid reset 🔑"],
  ])("refuses %s as UTF-32 hex, in either byte order, with a byte order mark and as BitConverter writes it", (_label, phrase) => {
    const le = utf32Hex(phrase);
    const be = utf32Hex(phrase, false);
    for (const token of [le, be, le.toUpperCase(), `fffe0000${le}`, `0000feff${be}`, bytePairs(le.toUpperCase()), `7${le}`, le.slice(2)]) {
      expect(resetTokenWeakness(token)).toBe("hex-text");
    }
  });

  // Round 6: Chinese in the Windows code page of a Chinese Windows, GBK
  // (cp936) or Big5 (cp950), which is what Windows PowerShell 5.1's
  // [Text.Encoding]::Default writes there. The bytes are Python's gbk,
  // big5 and euc-kr codecs'.
  const DOUBLE_BYTE_PHRASES = [
    ["GBK", "重置密码面板令牌", "gbk", "d6d8d6c3c3dcc2ebc3e6b0e5c1eec5c6"],
    ["GBK", "僵尸毁灭工程控制面板", "gbk", "bda9caacbbd9c3f0b9a4b3ccbfd8d6c6c3e6b0e5"],
    ["GBK", "我的僵尸毁灭工程服务器", "gbk", "ced2b5c4bda9caacbbd9c3f0b9a4b3ccb7fecef1c6f7"],
    ["GBK", "2026 服务器，重置密码！", "gbk", "3230323620b7fecef1c6f7a3acd6d8d6c3c3dcc2eba3a1"],
    ["Big5", "控制面板重設密碼", "big5", "b1b1a8eeadb1aa4fadabb35db14bbd58"],
    ["Big5", "喪屍伺服器重設密碼", "big5", "b3e0abcda6f8aa41beb9adabb35db14bbd58"],
    ["Big5", "2026 伺服器，重設密碼！", "big5", "3230323620a6f8aa41beb9a141adabb35db14bbd58a149"],
    // Korean in EUC-KR (cp949) uses the bytes of GB 2312's level 1.
    ["EUC-KR", "관리자 비밀번호 초기화", "euc-kr", "b0fcb8aec0da20baf1b9d0b9f8c8a320c3cab1e2c8ad"],
  ];
  it.each(DOUBLE_BYTE_PHRASES)("refuses %s hex of %s", (_encoding, _phrase, _label, hex) => {
    for (const token of [hex, hex.toUpperCase(), bytePairs(hex.toUpperCase()), `a${hex}`, hex.slice(0, 32)]) {
      expect(resetTokenWeakness(token)).toBe("hex-text");
    }
  });

  it.skipIf(!canDecodeLegacy)("has the bytes of those phrases right", () => {
    for (const [, phrase, label, hex] of DOUBLE_BYTE_PHRASES) {
      expect(new TextDecoder(label, { fatal: true }).decode(Buffer.from(hex, "hex"))).toBe(phrase);
    }
  });

  // Round 6: the other emoji and symbols of the 16-bit range.
  it.each([
    ["stars", "zomboid⭐panel⭐reset"],
    ["play and back", "▶▶▶ reset ◀◀◀"],
    ["alarm clocks", "⏰reset⏰panel⏰"],
    ["arrows", "↔zomboid↔reset↔"],
    ["arrows and squares", "⬆⬆ zomboid ⬛⬛"],
  ])("refuses a phrase with %s as UTF-16 hex", (_label, phrase) => {
    const le = hexOf(phrase, "utf16le");
    for (const token of [le, utf16be(phrase), bytePairs(le.toUpperCase())]) {
      expect(token.replaceAll("-", "").length).toBeGreaterThanOrEqual(32);
      expect(resetTokenWeakness(token)).toBe("hex-text");
    }
  });

  it("doesn't read random hex as text", () => {
    for (const token of [...sample("text-hex48", HEX, 48, 20000), ...sample("text-hex64", HEX, 64, 2000)]) {
      expect(resetTokenReadsAsText(token)).toBe(false);
    }
  });
});

// Round 5: the everyday Chinese, Japanese and Korean characters are
// written out as bits (utils/resetTokenCjkChars.js), since the packaged
// builds' Node can't decode the legacy encodings that list them. Where this
// Node can, read them again and compare.
describe("reset-token: the everyday Chinese, Japanese and Korean characters", () => {
  const canDecode = (() => {
    try {
      new TextDecoder("gb2312");
      return true;
    } catch {
      return false;
    }
  })();

  function decodeLevel(label, firstRow, lastRow, columns, lastCode) {
    const decoder = new TextDecoder(label);
    const chars = [];
    for (let row = firstRow; row <= lastRow; row++) {
      for (const column of columns) {
        if (row * 256 + column > lastCode) continue;
        const text = decoder.decode(Uint8Array.from([row, column]));
        if (text.length === 1 && text !== "�") chars.push(text.charCodeAt(0));
      }
    }
    return chars;
  }
  const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

  it.skipIf(!canDecode)("are the first levels of GB 2312, Big5 and JIS X 0208, and KS X 1001's syllables", () => {
    const levels = {
      gb2312: decodeLevel("gb2312", 0xb0, 0xd7, range(0xa1, 0xfe), 0xd7f9),
      big5: decodeLevel("big5", 0xa4, 0xc6, [...range(0x40, 0x7e), ...range(0xa1, 0xfe)], 0xc67e),
      eucjp: decodeLevel("euc-jp", 0xb0, 0xcf, range(0xa1, 0xfe), 0xcfd3),
      euckr: decodeLevel("euc-kr", 0xb0, 0xc8, range(0xa1, 0xfe), 0xffff),
    };
    expect(Object.fromEntries(Object.entries(levels).map(([label, chars]) => [label, chars.length]))).toEqual({
      gb2312: 3755,
      big5: 5401,
      eucjp: 2965,
      euckr: 2350,
    });
    const expected = new Set(Object.values(levels).flat());
    const wrong = [];
    for (let unit = 0; unit <= 0xffff; unit++) {
      if (isCommonCjkChar(unit) !== expected.has(unit)) wrong.push(unit.toString(16));
    }
    expect(wrong).toEqual([]);
    expect(expected.size).toBe(9524);
    expect([...expected].every((unit) => unit >= COMMON_CJK_FIRST && unit <= COMMON_CJK_LAST)).toBe(true);
  });

  it("counts the characters of everyday words, and not rare ones", () => {
    for (const char of "重置密码面板令牌設權杖再定비밀번호재설정") expect(isCommonCjkChar(char.charCodeAt(0))).toBe(true);
    // 殭, the first character of the traditional Chinese for "zombie", is
    // in none of the first levels.
    expect(isCommonCjkChar("殭".charCodeAt(0))).toBe(false);
    expect(isCommonCjkChar("a".charCodeAt(0))).toBe(false);
  });

  // Round 6: hex of GBK or Big5 text is read without a decoder, at the
  // byte values of these same first levels and of their punctuation and
  // full-width rows. Where this Node can decode them, check those bytes are
  // these characters, and that every one of them is read as text.
  it.skipIf(!canDecode)("are read as GBK and Big5 text at the bytes those code pages give them", () => {
    const pairs = (leads, trails, first, last) =>
      leads.flatMap((lead) => trails.map((trail) => [lead, trail])).filter(([lead, trail]) => {
        const code = lead * 256 + trail;
        return code >= first && code <= last;
      });
    const big5Trails = [...range(0x40, 0x7e), ...range(0xa1, 0xfe)];
    const codePages = {
      gbk: {
        level1: pairs(range(0xb0, 0xd7), range(0xa1, 0xfe), 0xb0a1, 0xd7f9),
        punctuation: [...pairs([0xa1], range(0xa1, 0xfe), 0, 0xffff), ...pairs([0xa3], range(0xa1, 0xfe), 0, 0xffff)],
      },
      big5: {
        level1: pairs(range(0xa4, 0xc6), big5Trails, 0xa440, 0xc67e),
        punctuation: pairs(range(0xa1, 0xa3), big5Trails, 0xa140, 0xa3bf),
      },
    };
    expect(codePages.gbk.level1).toHaveLength(3755);
    expect(codePages.big5.level1).toHaveLength(5401);
    for (const [label, { level1, punctuation }] of Object.entries(codePages)) {
      const decoder = new TextDecoder(label, { fatal: true });
      const decode = ([lead, trail]) => decoder.decode(Uint8Array.from([lead, trail]));
      expect(level1.map(decode).filter((char) => char.length !== 1 || !isCommonCjkChar(char.charCodeAt(0)))).toEqual([]);
      expect(punctuation.map(decode).filter((char) => char.length !== 1)).toEqual([]);
      const chars = [...level1, ...punctuation];
      for (let i = 0; i < chars.length; i += 8) {
        const token = Buffer.from(chars.slice(i, i + 8).flat()).toString("hex");
        expect({ label, token, text: resetTokenReadsAsText(token) }).toEqual({ label, token, text: true });
      }
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

  // Round 4: the near variants. cmd's `echo %RANDOM%> file` (or with a
  // space before the >) hashed with certutil -hashfile or Get-FileHash, so
  // a Windows line break; coreutils' sha224sum and sha384sum; common words
  // with a digit or in capitals; the example UUIDs in database docs.
  it.each([
    ["cmd's echo %RANDOM%>file | certutil (SHA1)", "sha1", "12345\r\n", 40],
    ["cmd's echo %RANDOM% > file | Get-FileHash (SHA256)", "sha256", "4242 \r\n", 64],
    ["cmd's echo %RANDOM%>file | certutil MD5", "md5", "31337\r\n", 32],
    ["cmd's echo %RANDOM% > file | certutil MD5", "md5", "0 \r\n", 32],
    ["sha224sum", "sha224", "12345\n", 56],
    ["echo -n | sha224sum | head -c 32", "sha224", "777", 32],
    ["sha384sum | head -c 32", "sha384", "12345\n", 32],
    ["sha384sum, whole", "sha384", "32767\n", 96],
  ])("refuses a hash of $RANDOM: %s", (_label, algorithm, input, length) => {
    const token = digest(algorithm, input).slice(0, length);
    expect(isWellKnownResetToken(token)).toBe(true);
    expect(isWellKnownResetToken(token.toUpperCase())).toBe(true);
    expect(resetTokenWeakness(token)).toBe("well-known");
  });

  it.each([
    ["echo password1 | md5sum", "md5", "password1\n"],
    ["echo PASSWORD | md5sum", "md5", "PASSWORD\n"],
    ["sha256 of admin123", "sha256", "admin123"],
    ["echo ZOMBOID | sha1sum", "sha1", "ZOMBOID\n"],
  ])("refuses the %s", (_label, algorithm, input) => {
    expect(resetTokenWeakness(digest(algorithm, input))).toBe("well-known");
  });

  it.each([
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "6F9619FF-8B86-D011-B42D-00C04FC964FF",
    "6ccd780c-baba-1026-9564-5b8c656024db",
  ])("refuses the database docs' example UUID %s", (uuid) => {
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

  // Round 4: each caller used to run its own slices, and Node runs every
  // queued setImmediate callback in one go, so 50 requests arriving
  // together worked through 50 slices between two turns of the event loop.
  it("shares one build among callers that ask at the same time", async () => {
    vi.resetModules();
    const fresh = await import("../utils/resetTokenStrength.js");
    let ticks = 0;
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const callers = Array.from({ length: 50 }, () => fresh.prepareResetTokenChecks());
    await Promise.all(callers);
    running = false;
    expect(ticks).toBeGreaterThan(20);
    expect(fresh.isWellKnownResetToken(digest("sha1", "4096\n"))).toBe(true);
  });
});

// Round 3 of the A2 verification: the natural way to write the file on
// Windows, `openssl rand -hex 24 > data\reset-token.txt` in Windows
// PowerShell, writes UTF-16 with a byte order mark; read as UTF-8 that was
// refused as "not hex".
describe("reading data/reset-token.txt", () => {
  const token = "3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59";
  const utf16le = (text) => Buffer.from(text, "utf16le");
  const utf32 = (text, littleEndian) => {
    const bytes = Buffer.alloc(text.length * 4);
    Array.from(text).forEach((char, i) =>
      littleEndian ? bytes.writeUInt32LE(char.codePointAt(0), 4 * i) : bytes.writeUInt32BE(char.codePointAt(0), 4 * i),
    );
    return bytes;
  };
  it.each([
    ["a trailing line break", Buffer.from(`${token}\n`)],
    ["a Windows line break", Buffer.from(`${token}\r\n`)],
    ["no line break", Buffer.from(token)],
    ["UTF-8 with a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${token}\r\n`)])],
    ["UTF-16LE with a byte order mark (Windows PowerShell's > and Out-File)", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(`${token}\r\n`)])],
    ["UTF-16BE with a byte order mark", Buffer.concat([Buffer.from([0xfe, 0xff]), utf16le(`${token}\r\n`).swap16()])],
    ["UTF-16LE cut off by a byte", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(`${token}\n`), Buffer.from([0x20])])],
    // Round 4: Set-Content -Encoding utf32 writes UTF-32LE, whose byte order
    // mark starts like UTF-16LE's; read as UTF-16 it was refused as not hex.
    ["UTF-32LE with a byte order mark (Set-Content -Encoding utf32)", Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), utf32(`${token}\r\n`, true)])],
    ["UTF-32BE with a byte order mark", Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), utf32(`${token}\r\n`, false)])],
  ])("reads the token from a file with %s", (_label, bytes) => {
    expect(decodeResetTokenFile(bytes)).toBe(token);
  });
});

// Round 6 of the A2 verification: a test here drew 200 UUIDs and 400
// tokens of 48 hex characters without a seed, and about 1 random UUID in
// 15,000 is refused, so release CI failed about one run in 70. Every
// random token in the reset-token suites comes from a fixed seed.
describe("the reset-token suites", () => {
  it.each(["resetTokenStrength.test.js", "resetTokenHardening.test.js", "resetTokenCheckWarmup.test.js"])(
    "%s draws no random token without a seed",
    (file) => {
      const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
      // (This line doesn't match itself: the backslashes are in the way.)
      expect(source.match(/crypto\.random(?:Bytes|UUID|Int)\(|Math\.random\(|getRandomValues\(/g)).toBeNull();
    },
  );
});
