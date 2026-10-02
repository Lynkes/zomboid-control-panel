/**
 * What Project Zomboid itself reads from each server.ini line, for the
 * Server Settings form. serverFiles.js's parseIni() trims every key and value
 * with JavaScript's trim(), which is right for the panel's other readers but
 * not what the game does, so the form reads the same lines through this.
 *
 * zombie.config.ConfigFile.read (42.21, checked by running it from
 * projectzomboid.jar on the game's own Java 25 runtime):
 *   - each line is trimmed with Java's String.trim(), which removes only the
 *     chars up to U+0020 -- not a no-break space or a byte-order mark;
 *   - the line is split on "=". The text before the first "=" is the option
 *     name exactly as written, so "Public = true" names an option "Public "
 *     that the game doesn't have, and the line has no effect;
 *   - the value is the next piece, not trimmed again: "Public= true" hands
 *     " true" to BooleanConfigOption, which rejects it and keeps the default.
 *     Numbers go through Double.parseDouble, which trims chars up to U+0020
 *     itself, so " 16" still reads as 16 but a no-break space does not.
 * The client applies those per-type rules (client/src/lib/iniFormState.ts);
 * this module only hands it the text.
 */

// Java's String.trim(): every char up to U+0020 comes off both ends.
export function javaTrim(text) {
  return javaTrimEnd(javaTrimStart(text));
}

export function javaTrimStart(text) {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++;
  return text.slice(start);
}

export function javaTrimEnd(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(0, end);
}

/**
 * One assignment line, given the index of its first "=":
 *   - value: everything after that "=", with only the line end trimmed as
 *     Java trims it. Later "=" signs are kept, so the text round-trips; the
 *     game itself reads only up to the next one.
 *   - gameName: the option name the game reads, i.e. the text before "="
 *     after Java's trim of the line start.
 */
export function readIniLineAsGame(line, eqIndex) {
  return {
    value: javaTrimEnd(line.slice(eqIndex + 1)),
    gameName: javaTrimStart(line.slice(0, eqIndex)),
  };
}

/**
 * The same keys parseIni() returns (same skipped lines, same JavaScript-trimmed
 * key, last line wins), each with its value as the game reads it.
 * `misnamed` lists the keys whose line the game files under another name --
 * a space or tab before "=", or a no-break space or BOM before the key -- so
 * that line has no effect; it maps each key to the name the game sees.
 *
 * @param {string} content - Raw server.ini text.
 * @returns {{ values: Record<string, string>, misnamed: Record<string, string> }}
 */
export function parseIniAsGame(content) {
  const values = {};
  const misnamed = {};
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (trimmed.indexOf("=") <= 0) continue;
    const key = trimmed.substring(0, trimmed.indexOf("=")).trim();
    const { value, gameName } = readIniLineAsGame(line, line.indexOf("="));
    values[key] = value;
    if (gameName === key) delete misnamed[key];
    else misnamed[key] = gameName;
  }
  return { values, misnamed };
}

/**
 * Whether saving `value` for `key` changes what the file says, given the
 * file's current parseIniAsGame() view: PUT /ini's toIni() rewrites a line
 * exactly when this is true. A key absent from the file only gets a line
 * when the value is non-empty.
 */
export function iniValueChanges(view, key, value) {
  const text = String(value ?? "").replace(/[\r\n]/g, "");
  if (!Object.prototype.hasOwnProperty.call(view.values, key)) return text !== "";
  return Object.prototype.hasOwnProperty.call(view.misnamed, key) || view.values[key] !== text;
}
