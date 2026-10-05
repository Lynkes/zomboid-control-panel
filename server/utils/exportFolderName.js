/**
 * Folder names for <dataDir>/exports/<player>/ (character exports: login
 * auto-exports and the pre-import snapshots).
 *
 * These folders used to be named by squashing every character outside
 * [a-zA-Z0-9_-] to "_", so two different players could share one folder:
 * "Bob 1" and "Bob_1" are both valid, distinct Project Zomboid usernames
 * and both became exports/Bob_1/. The login auto-export keeps only the
 * newest N files in its folder, so one player's logins deleted the other
 * player's exports and left their own in their place, under the other
 * player's name.
 *
 * The folder is now "@" followed by the lowercase hex of the exact name's
 * UTF-8 bytes: one name, one folder, and the name can be read back from
 * it. Lowercase hex because Windows and macOS folders ignore letter case,
 * so an encoding that used both cases could still put two names in one
 * folder. The "@" keeps these apart from the old folders, whose names
 * never contain it. The old folders are only read, never written to again.
 */

const ENCODED_PREFIX = "@";
// A path segment may be 255 bytes on every filesystem the panel runs on;
// 120 bytes of name is 241 characters once encoded. Project Zomboid itself
// refuses a username longer than 32 characters
// (ServerWorldDatabase.isValidUserName, checked against B42), which is at
// most 96 bytes of UTF-8, so every real player name fits.
const MAX_NAME_BYTES = 120;
const ENCODED_FOLDER_RE = /^@(?:[0-9a-f]{2})+$/;

// The characters the old folder names were reduced to. Also what the
// download/delete routes accept for an old folder.
export const LEGACY_EXPORT_FOLDER_RE = /^[a-zA-Z0-9_-]+$/;

/** The old, lossy folder name (also still used inside export file names). */
export function legacyExportFolderName(username) {
  return String(username).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The export folder for exactly this username, or null when there can be
 * none (not a string, empty, too long, or not valid Unicode text: a lone
 * surrogate would encode the same as U+FFFD, so two names would share a
 * folder again).
 */
export function encodeExportFolderName(username) {
  if (typeof username !== "string" || username.length === 0) return null;
  if (!username.isWellFormed()) return null;
  const bytes = Buffer.from(username, "utf8");
  if (bytes.length > MAX_NAME_BYTES) return null;
  return ENCODED_PREFIX + bytes.toString("hex");
}

/** The username an export folder belongs to, or null for an old folder. */
export function decodeExportFolderName(folderName) {
  if (typeof folderName !== "string" || !ENCODED_FOLDER_RE.test(folderName)) {
    return null;
  }
  const username = Buffer.from(folderName.slice(ENCODED_PREFIX.length), "hex").toString("utf8");
  // Only the folder encodeExportFolderName() itself would make for that
  // name counts: bytes that are not valid UTF-8 decode to U+FFFD and would
  // not survive the round trip.
  return encodeExportFolderName(username) === folderName ? username : null;
}
