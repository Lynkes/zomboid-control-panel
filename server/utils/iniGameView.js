/**
 * What Project Zomboid itself reads from each server.ini line, for the
 * Server Settings form. serverFiles.js's parseIni() trims every key and value
 * with JavaScript's trim(), which is right for the panel's other readers but
 * not what the game does, so the form reads the same lines through this.
 *
 * zombie.config.ConfigFile.read (42.21, checked by running it from
 * projectzomboid.jar on the game's own Java 25 runtime):
 *   - lines are read with BufferedReader.readLine, so "\r\n", "\n" and a lone
 *     "\r" each end one (INI_LINE_BREAK);
 *   - each line is trimmed with Java's String.trim(), which removes only the
 *     chars up to U+0020 -- not a no-break space or a byte-order mark;
 *   - the line is split on "=". The text before the first "=" is the option
 *     name exactly as written, so "Public = true" names an option "Public "
 *     that the game doesn't have, and the line has no effect;
 *   - the value is the next piece, not trimmed again: "Public= true" hands
 *     " true" to BooleanConfigOption, which rejects it and keeps the default.
 *     Numbers go through Double.parseDouble, which trims chars up to U+0020
 *     itself, so " 16" still reads as 16 but a no-break space does not;
 *   - a line it can't make an option of ("= x") makes it ignore the WHOLE
 *     file (findIniFatalLines): the server then runs on the default of every
 *     setting.
 * The client applies those per-type rules (client/src/lib/iniFormState.ts);
 * this module only hands it the text.
 */

// BufferedReader.readLine's line ends.
export const INI_LINE_BREAK = /\r\n|\r|\n/;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

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

// The key a line is listed under: its name with everything either trim
// removes taken off both ends -- Java's chars up to U+0020 (control chars
// too, which JavaScript's trim() keeps) and JavaScript's whitespace (a
// no-break space, a BOM, which Java's keeps). Whether the game reads the line
// under that key is then gameName === key.
function listedKey(text) {
  const trimmedByEither = (index) => text.charCodeAt(index) <= 0x20 || /\s/.test(text[index]);
  let start = 0;
  let end = text.length;
  while (start < end && trimmedByEither(start)) start++;
  while (end > start && trimmedByEither(end - 1)) end--;
  return text.slice(start, end);
}

/**
 * Each key the game reads from the file, with its value as the game reads it.
 * Lines are the ones the game reads: they end where the game ends them (a
 * lone "\r" ends one, parseIni() keeps it inside one), and only a line
 * starting with "#" after Java's trim is a comment -- the game reads ";x=1"
 * as an option named ";x" (parseIni() skips it), which no setting is.
 * `misnamed` lists the keys whose line the game files under another name --
 * a space or tab before "=", or a no-break space or BOM before the key -- so
 * that line has no effect; it maps each key to the name the game sees.
 * As in the game, the last line it reads for a key wins, and a line it skips
 * doesn't count: "PVP=false" then "PVP = true" is PVP=false, not misnamed.
 *
 * SECURITY (2026-10-20): the key is taken from the line as Java trims it. A
 * control char before a name ("\u0001RCONPassword=x") is removed by Java's
 * trim and kept by JavaScript's, so the governed-key check
 * (iniKeyCapability.js) used to see a key "\u0001RCONPassword" that no
 * capability covers while the game read RCONPassword from that line.
 *
 * @param {string} content - Raw server.ini text.
 * @returns {{ values: Record<string, string>, misnamed: Record<string, string> }}
 */
export function parseIniAsGame(content) {
  const values = {};
  const misnamed = {};
  for (const line of String(content ?? "").split(INI_LINE_BREAK)) {
    const gameLine = javaTrim(line);
    if (!gameLine || gameLine.startsWith("#")) continue;
    const key = listedKey(gameLine.substring(0, Math.max(0, gameLine.indexOf("="))));
    if (!key) continue;
    const { value, gameName } = readIniLineAsGame(line, line.indexOf("="));
    if (gameName === key) {
      values[key] = value;
      delete misnamed[key];
    } else if (!hasOwn(values, key) || hasOwn(misnamed, key)) {
      values[key] = value;
      misnamed[key] = gameName;
    }
  }
  return { values, misnamed };
}

/**
 * The lines that make the game ignore the whole file, numbered from 1 as the
 * game counts lines. ConfigFile.read splits each Java-trimmed line with
 * String.split("="), which drops trailing empty pieces, and throws -- so the
 * read fails -- when the first piece is empty ("=", "= x", "==") or is the
 * version line's "Version" with no number after it ("Version="). Then
 * ServerOptions applies no option from the file and leaves the file as it
 * is, so the server runs on the default of every setting.
 *
 * @param {string} content - Raw server.ini text.
 * @returns {number[]}
 */
export function findIniFatalLines(content) {
  const fatal = [];
  String(content ?? "").split(INI_LINE_BREAK).forEach((rawLine, index) => {
    const line = javaTrim(rawLine);
    if (!line || line.startsWith("#") || !line.includes("=")) return;
    const pieces = line.split("=");
    while (pieces.length > 0 && pieces[pieces.length - 1] === "") pieces.pop();
    if (pieces.length === 0 || pieces[0] === "" || (pieces[0] === "Version" && pieces.length === 1)) {
      fatal.push(index + 1);
    }
  });
  return fatal;
}

/**
 * Whether saving `value` for `key` changes what the game reads from the
 * file, given the file's current parseIniAsGame() view. PUT /ini's toIni()
 * rewrites the line the game reads for the key exactly when this is true.
 * (It can also rewrite another, duplicate line for the key to that same
 * value; PUT /ini refuses a file that repeats a `Key=` line before this
 * runs.) A key absent from the file only gets a line when the value is
 * non-empty.
 */
export function iniValueChanges(view, key, value) {
  const text = String(value ?? "").replace(/[\r\n]/g, "");
  if (!hasOwn(view.values, key)) return text !== "";
  return hasOwn(view.misnamed, key) || view.values[key] !== text;
}
