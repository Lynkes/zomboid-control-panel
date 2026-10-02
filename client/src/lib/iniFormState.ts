// Server Settings (server.ini) form state: what the structured editor shows
// for a loaded file, and what it sends back on save.
//
// The form works on GET /server-files/ini's `rawSettings`: each value exactly
// as the game reads it from its line (server/utils/iniGameView.js), not
// parseIni()'s trimmed copy. The readers below apply the game's per-type
// rules to that text, and an untouched value goes back unchanged, so the
// server leaves its line byte-for-byte.

import { INI_SCHEMA, parseNumericSettingValue, type NumericSettingBounds } from './serverConfigSchema'

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
 * The text Double.parseDouble reads for a server.ini number: PZ's integer,
 * double and enum options all parse pzOptionText with it, and it trims the
 * chars up to U+0020 itself, so "MaxPlayers= 16" is 16. The Server Settings
 * selects are all integer or enum options in the game, so they match their
 * options against this too.
 */
export function pzNumberText(value: string): string {
  return javaTrim(pzOptionText(value))
}

/**
 * Whether the game can't read this server.ini number because of a space it
 * doesn't trim: a no-break space, a BOM or another Unicode space next to the
 * digits (Double.parseDouble throws, so the option keeps its default).
 * JavaScript's trim() and Number() would take them, and they are invisible
 * in the form, so the row says what it found.
 */
export function pzNumberHasStraySpace(value: string): boolean {
  return /\s/u.test(pzNumberText(value))
}

/**
 * Read a server.ini number as the game does (pzNumberText), then apply the
 * panel's own number rules and bounds (parseNumericSettingValue). Returns
 * null for a value either one rejects.
 */
export function parseIniNumber(
  value: unknown,
  bounds: NumericSettingBounds = {},
  options: { enforceBounds?: boolean } = {},
): number | null {
  const text = pzNumberText(String(value ?? ''))
  if (/\s/u.test(text)) return null
  return parseNumericSettingValue(text, bounds, options)
}

/**
 * A server.ini value or option name for a warning, with the characters that
 * change how the game reads it made visible: a space as ␣, any other space,
 * control or invisible char as [U+XXXX] (e.g. [U+00A0] for a no-break space,
 * [U+FEFF] for a BOM).
 */
export function showIniWhitespace(text: string): string {
  return text.replace(/[\s\p{Cc}\p{Cf}]/gu, (ch) => (
    ch === ' ' ? '␣' : `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`
  ))
}

/** The INI form state for a loaded file. */
export interface LoadedIniForm {
  /**
   * The file's own keys, plus a schema default for each non-legacy schema
   * key it lacks or whose line the game skips.
   */
  settings: Record<string, string>
  /**
   * The keys a save leaves out unless the operator changes them: the schema
   * keys filled with a default, and every key whose line the game skips.
   */
  defaultedKeys: Set<string>
}

/**
 * Fill every schema key the file lacks with its default, so the form can show
 * it, and record which ones were filled so a save leaves them out
 * (buildIniSavePayload). Legacy (Build 41-only) keys are never filled: the
 * form shows them only when the file has them. Also warns to the console when
 * a stored value doesn't parse for the schema type -- helps catch a corrupted
 * INI without changing behaviour.
 *
 * `misnamedKeys` (GET /ini) are the keys whose line the game skips, because
 * it reads the option name with a space before "=" or a BOM before the key.
 * For the game such a key is missing, so a non-legacy schema key shows its
 * default the same way. Every one of them is left out of a save until the
 * operator changes it: the line stays as written, and once they do, PUT /ini
 * rewrites it as `Key=value`, which the game reads.
 */
export function mergeIniSchemaDefaults(
  parsed: Record<string, string>,
  misnamedKeys: Readonly<Record<string, string>> = {},
): LoadedIniForm {
  const settings = { ...parsed }
  const defaultedKeys = new Set(Object.keys(misnamedKeys).filter((key) => key in settings))
  for (const setting of INI_SCHEMA) {
    const inFile = setting.key in settings && !(setting.key in misnamedKeys)
    if (!inFile) {
      if (setting.legacy) continue
      settings[setting.key] = String(setting.default ?? '')
      defaultedKeys.add(setting.key)
      continue
    }
    const raw = settings[setting.key]
    if (raw == null || raw === '') continue
    if (setting.type === 'boolean' && parsePzBoolean(raw) === null) {
      console.warn(`[ServerConfig] ${setting.key} expected boolean, got "${raw}"`)
    } else if (setting.type === 'number' && parseIniNumber(raw, setting, { enforceBounds: false }) === null) {
      console.warn(`[ServerConfig] ${setting.key} expected number, got "${raw}"`)
    } else if (setting.type === 'select' && setting.options && !setting.options.some(o => o.value === pzNumberText(raw))) {
      console.warn(`[ServerConfig] ${setting.key} expected one of [${setting.options.map(o => o.value).join('|')}], got "${raw}"`)
    }
  }
  return { settings, defaultedKeys }
}

/**
 * The settings object PUT /server-files/ini receives. A key
 * mergeIniSchemaDefaults filled in (the file lacks it) is left out unless the
 * operator changed it: the server's INI writer appends every new non-empty
 * key, so resending the panel's default would add it to the file on any
 * unrelated save, and the game already uses its own default for a key the
 * file doesn't have. Every key the file does have is sent, as before.
 */
export function buildIniSavePayload(
  current: Record<string, string>,
  loaded: Record<string, string>,
  defaultedKeys: ReadonlySet<string>,
): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const [key, value] of Object.entries(current)) {
    if (defaultedKeys.has(key) && value === loaded[key]) continue
    payload[key] = value
  }
  return payload
}
