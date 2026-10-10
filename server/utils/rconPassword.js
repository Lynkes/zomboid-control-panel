/**
 * What an RCON password has to look like to survive a round trip through
 * the server's .ini.
 *
 * The panel keeps the RCON password in its own settings and writes the same
 * text to `RCONPassword=` in the server .ini, and the panel's RCON login only
 * works while the two agree. Project Zomboid reads a .ini value with
 * zombie.config.ConfigFile.read (42.21, run from projectzomboid.jar on the
 * game's own Java 25 runtime -- see iniGameView.js):
 *   - a line ends at "\r", "\n" or "\r\n", so a password with a line break
 *     would end the line early and leave the rest as a line of its own;
 *   - the line is split on "=" and the value is the piece after the first
 *     one, so "ab=cd" is "ab" to the game (the same run read "ab=cd" back as
 *     "ab");
 *   - nothing else is special inside a value: ";" and "#" (only a "#" at the
 *     start of a line starts a comment), quotes, "$" and backslashes all come
 *     back exactly as written.
 * So only "=" and line breaks can't be written in a form the game reads back
 * identically. They are refused when the password is saved, not stripped
 * from the .ini copy: stripping left the game on a different password than
 * the panel, and every RCON login failed with no hint why. ";" used to be
 * stripped too (sanitizeIniValue is made for the ";"-separated list fields)
 * and is written as it is now.
 */

import { ErrorCode } from "./errorCodes.js";

const UNREADABLE_IN_INI = /[=\r\n]/;

/**
 * Whether the game would read a different value than `password` from a
 * server .ini line `RCONPassword=<password>`. Judged on the text the line
 * would hold (String(password), which is what a template literal writes), so
 * an array or object body value can't carry a line break past the check; an
 * absent password has nothing to refuse.
 *
 * @param {unknown} password
 * @returns {boolean}
 */
export function rconPasswordCannotBeStoredInIni(password) {
  return password != null && UNREADABLE_IN_INI.test(String(password));
}

/** The 400 body for a password that can't be stored in the .ini. */
export function rconPasswordUnsupportedCharsBody() {
  return {
    error:
      'The RCON password cannot contain "=" or a line break: Project Zomboid reads a server.ini value only up to the first "=", so the game would end up with a different password than the panel.',
    code: ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS,
  };
}
