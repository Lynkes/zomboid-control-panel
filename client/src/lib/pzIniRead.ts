// How Project Zomboid 42.21 itself reads a server.ini line
// (zombie.config.ConfigFile.read; server/utils/iniGameView.js has the
// details). No imports on purpose: bridgeDeliveryView.ts reads DoLuaChecksum
// with these too, and it is on pages that don't load the INI schema.
// iniFormState.ts re-exports them for the Server Settings form.

/** Java's String.trim(): only the chars up to U+0020 come off both ends. */
export function javaTrim(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && text.charCodeAt(start) <= 0x20) start++
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--
  return text.slice(start, end)
}

/**
 * The text PZ 42.21 hands an option's parser, given the text after the line's
 * first "=". zombie.config.ConfigFile.read trims the whole line (Java
 * String.trim), splits it on "=" and keeps only the piece after the first
 * one; nothing trims that piece again. So only the line's end is trimmed, and
 * that is this piece's end only when no further "=" follows it:
 * "Hello = world" reads as "Hello ".
 */
export function pzOptionText(value: string): string {
  let end = value.indexOf('=')
  if (end === -1) {
    end = value.length
    while (end > 0 && value.charCodeAt(end - 1) <= 0x20) end--
  }
  return value.slice(0, end)
}

/**
 * Read a server.ini boolean the way PZ 42.21 does, given the text after the
 * line's first "=" (see pzOptionText). BooleanConfigOption.parse takes
 * "true"/"1" as on and "false"/"0" as off (String.equalsIgnoreCase). Anything
 * else is logged and dropped, so the option keeps its default: B41's
 * SteamScoreboard=admin, "Public= true", "Public=true =x". Returns null for
 * such a value.
 */
export function parsePzBoolean(value: string): boolean | null {
  const text = pzOptionText(value)
  // The u flag case-folds these words exactly as Java's equalsIgnoreCase
  // does (it also takes "falſe", with a long s, as the game does).
  if (/^(?:true|1)$/iu.test(text)) return true
  if (/^(?:false|0)$/iu.test(text)) return false
  return null
}

/**
 * The lines of a server.ini text that make the game ignore the WHOLE file,
 * numbered from 1 as the game counts lines (a lone "\r" ends one, as in
 * BufferedReader.readLine). ConfigFile.read splits each Java-trimmed line
 * with String.split("="), which drops trailing empty pieces, and fails when
 * the first piece is empty ("=", "= x", "==") or is "Version" with no number
 * after it ("Version="). The server then runs on the default of every
 * setting. Same rule as server/utils/iniGameView.js findIniFatalLines, which
 * GET /server-files/ini reports as `fatalLines`; this one reads the raw
 * editor's text as the operator types.
 */
export function findIniFatalLines(content: string): number[] {
  const fatal: number[] = []
  content.split(/\r\n|\r|\n/).forEach((rawLine, index) => {
    const line = javaTrim(rawLine)
    if (!line || line.startsWith('#') || !line.includes('=')) return
    const pieces = line.split('=')
    while (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop()
    if (pieces.length === 0 || pieces[0] === '' || (pieces[0] === 'Version' && pieces.length === 1)) {
      fatal.push(index + 1)
    }
  })
  return fatal
}
