import { ErrorCode } from "../utils/errorCodes.js";

// SECURITY (2026-10-20, access-control audit): the rules every NEW panel
// password follows -- first-run setup, creating an account, changing your
// own, and setting one without the old one (reset token, recovery code,
// --reset-password). A password already set keeps signing in: login never
// checks these.
//
//  - at least PASSWORD_MIN_LENGTH characters (it was 6);
//  - at most PASSWORD_MAX_BYTES bytes in UTF-8: bcrypt reads no further, so
//    two passwords sharing their first 72 bytes used to both sign in (and a
//    128-character limit let one look stronger than it was);
//  - not one of the most common passwords (COMMON_PASSWORDS, compared
//    without case), nor one character repeated.
//
// The client mirrors the two numbers (client/src/lib/passwordPolicy.ts) and
// shows the server's refusal for the list.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

// The most common passwords on public breach lists (several published "top
// 200" lists, merged). Most are shorter than the minimum and refused for that
// anyway; they stay listed so the list keeps meaning something if the
// minimum ever changes. Lower case.
const COMMON_PASSWORDS = new Set([
  "123456", "123456789", "12345678", "12345", "1234567", "1234567890",
  "123123", "000000", "111111", "121212", "123321", "654321", "666666",
  "696969", "7777777", "888888", "987654321", "0987654321", "112233",
  "123654", "147258369", "159753", "1q2w3e", "1q2w3e4r", "1q2w3e4r5t",
  "1q2w3e4r5t6y", "1qaz2wsx", "1qaz2wsx3edc", "zaq12wsx", "zaq1zaq1",
  "qwerty", "qwerty123", "qwerty1234", "qwerty12345", "qwerty123456",
  "qwertyuiop", "qwertyuiop123", "qwer1234", "qwe123", "qweasd",
  "qweasdzxc", "qazwsx", "qazwsxedc", "asdfgh", "asdfghjkl", "asdf1234",
  "asd123", "zxcvbnm", "zxcvbnm123", "1234qwer", "a123456", "a1b2c3",
  "a1b2c3d4", "abc123", "abc12345", "abcd1234", "abcdef", "abcdefg",
  "abcdefgh", "abcdefghij", "aa123456", "aaaaaa", "password", "password1",
  "password12", "password123", "password1234", "password!", "password1!",
  "passw0rd", "p@ssw0rd", "p@ssword", "pass1234", "pass123", "passpass",
  "letmein", "letmein123", "welcome", "welcome1", "welcome123",
  "welcome2024", "welcome2025", "welcome2026", "admin", "admin123",
  "admin1234", "admin12345", "administrator", "root", "toor", "changeme",
  "changeme123", "default", "guest", "login", "master", "secret",
  "secret123", "test", "test123", "test1234", "testing123", "user",
  "user1234", "iloveyou", "iloveyou1", "iloveyou12", "iloveyou123",
  "trustno1", "sunshine", "sunshine1", "princess", "princess1", "dragon",
  "dragon123", "monkey", "monkey123", "football", "football1", "baseball",
  "basketball", "soccer", "hockey", "superman", "batman", "spiderman",
  "starwars", "pokemon", "minecraft", "fortnite", "roblox", "zombie",
  "zombies", "projectzomboid", "zomboid", "zomboid123", "shadow",
  "michael", "jennifer", "jordan23", "charlie", "daniel", "jessica",
  "ashley", "hunter", "hunter2", "killer", "freedom", "whatever", "ninja",
  "mustang", "access", "flower", "lovely", "loveme", "love123", "hello",
  "hello123", "hellohello", "computer", "internet", "server", "server123",
  "gaming", "gamer123", "cheese", "chocolate", "summer", "summer2024",
  "summer2025", "winter", "autumn", "spring", "london", "berlin",
  "chicago", "liverpool", "arsenal", "chelsea", "barcelona", "realmadrid",
  "matrix", "qwertz", "qwertz123", "azerty", "azerty123", "azertyuiop",
  "motdepasse", "passwort", "contrasena", "senha123", "parol", "1password",
  "11111111", "1111111111", "00000000", "0000000000", "12341234",
  "12344321", "123qwe", "123qweasd", "123abc", "123456a", "123456789a",
  "1234567890a", "q1w2e3r4", "q1w2e3r4t5", "q1w2e3r4t5y6", "1a2b3c4d",
  "googledummy", "mypassword", "mypassword1", "yourpassword",
  "thisisapassword", "letmeinplease", "opensesame",
]);

export function isCommonPassword(password) {
  const lower = String(password).toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  // One character repeated ("aaaaaaaaaa", "1111111111").
  return lower.length > 0 && [...lower].every((ch) => ch === lower[0]);
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

/** The refusal for a new password, or null when it may be set. */
export function newPasswordProblem(password) {
  if (typeof password !== "string" || [...password].length < PASSWORD_MIN_LENGTH) {
    return makeError(
      ErrorCode.PASSWORD_TOO_SHORT,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return makeError(
      ErrorCode.PASSWORD_TOO_LONG_BYTES,
      `Password must be at most ${PASSWORD_MAX_BYTES} bytes (72 plain letters or digits; accented letters and other scripts count as 2-4 each): the panel ignores anything past that`,
    );
  }
  if (isCommonPassword(password)) {
    return makeError(
      ErrorCode.PASSWORD_TOO_COMMON,
      "This password is one of the most common ones and is easy to guess: choose another",
    );
  }
  return null;
}

/** Throws newPasswordProblem()'s coded, status-400 error, if any. */
export function assertNewPasswordPolicy(password) {
  const problem = newPasswordProblem(password);
  if (problem) throw problem;
}
