// The length rules for a new panel password, mirrored from
// server/services/passwordPolicy.js (which decides; this only lets a form
// say so before sending). The server also refuses the most common passwords
// (PASSWORD_TOO_COMMON) -- that list stays on the server, and its refusal is
// shown translated like any other error. A password already set keeps
// signing in whatever its length.
export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_BYTES = 72

/** At least PASSWORD_MIN_LENGTH characters (code points, as the server counts). */
export function meetsPasswordMinLength(password: string): boolean {
  return [...password].length >= PASSWORD_MIN_LENGTH
}

/** More UTF-8 bytes than bcrypt reads: the server refuses it (PASSWORD_TOO_LONG_BYTES). */
export function exceedsPasswordMaxBytes(password: string): boolean {
  return new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES
}
