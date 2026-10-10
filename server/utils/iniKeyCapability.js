import { parseIniAsGame } from "./iniGameView.js";

/**
 * Server .ini keys that need a capability on top of serverfiles.manage.
 *
 * Every Server Files route that writes the server .ini -- PUT /ini, PUT
 * /raw/ini, POST /restore/:filename and POST /templates/:id/apply -- can
 * change these, and they are the same fields server.js's own /configure-rcon
 * and /configure-network routes edit under server.configure: RCONPassword,
 * RCONPort, DefaultPort, UDPPort and UPnP. serverfiles.manage's description
 * ("Edit sandbox options, spawn points and other server config files") gives
 * no hint that holding it also lets a caller rewrite the RCON password or
 * the game's listen port, bypassing server.configure's own dedicated gate on
 * those exact fields (2026-08-26 capability-description sweep, finding 4).
 * PUT /ini checked them; the raw editor and the backup restore, which write
 * the same file, did not.
 */
export const INI_KEY_CAPABILITY = {
  RCONPassword: "server.configure",
  RCONPort: "server.configure",
  DefaultPort: "server.configure",
  UDPPort: "server.configure",
  UPnP: "server.configure",
};

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// What the game reads for `key`: the line's value, or "" when it reads none
// (no such line, or only a line it files under another name, like
// "RCONPort =27015" -- see parseIniAsGame()). The same equivalence
// iniValueChanges() uses for a key absent from the file.
function gameValueOf(view, key) {
  if (hasOwn(view.misnamed, key)) return "";
  return hasOwn(view.values, key) ? view.values[key] : "";
}

/**
 * The governed keys (INI_KEY_CAPABILITY) whose value the game reads
 * differently from `nextContent` than from `currentContent`. Judged on what
 * the game reads, not on the text, so a save that leaves every governed
 * value alone -- whatever else it changes, however the file is reformatted
 * -- needs nothing beyond serverfiles.manage; it is enforced on change, not
 * on presence, because the editors send the whole file on every save.
 *
 * @param {string} currentContent - The file as it is now ("" when it does not exist).
 * @param {string} nextContent - The file as it would be written.
 * @returns {string[]}
 */
export function governedIniKeysChanged(currentContent, nextContent) {
  const current = parseIniAsGame(currentContent);
  const next = parseIniAsGame(nextContent);
  return Object.keys(INI_KEY_CAPABILITY).filter(
    (key) => gameValueOf(current, key) !== gameValueOf(next, key),
  );
}
