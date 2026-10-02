// Server Settings (server.ini) form state: what the structured editor shows
// for a loaded file, and what it sends back on save.
//
// The form works on GET /server-files/ini's `rawSettings`: each value exactly
// as the game reads it from its line (server/utils/iniGameView.js), not
// parseIni()'s trimmed copy. The readers below apply the game's per-type
// rules to that text, and an untouched value goes back unchanged, so the
// server leaves its line byte-for-byte.

import { javaTrim, parsePzBoolean, pzOptionText } from './pzIniRead'
import { INI_SCHEMA, parseNumericSettingValue, type IniSetting, type NumericSettingBounds } from './serverConfigSchema'

// The game's own line and boolean readers live in pzIniRead.ts, which has no
// imports, so bridgeDeliveryView.ts can share them without the INI schema.
export { findIniFatalLines, javaTrim, parsePzBoolean, pzOptionText } from './pzIniRead'

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
 * Whether the game ends up on this setting's schema default with `value` on
 * its line, for the row's default highlight and the "changed from default"
 * filter. Each type is read as the game reads it: "MaxPlayers= 32" is 32, a
 * boolean or number it can't read (" false", "\u00A032") leaves its default,
 * and a select is a number. Text compares as written.
 */
export function iniValueIsDefault(setting: IniSetting, value: string): boolean {
  const fallback = String(setting.default ?? '')
  switch (setting.type) {
    case 'boolean': {
      const defaultOn = setting.default === true
      return (parsePzBoolean(value) ?? defaultOn) === defaultOn
    }
    case 'number': {
      const number = parseIniNumber(value, setting, { enforceBounds: false })
      return number === null || number === Number(fallback)
    }
    case 'select':
      return pzNumberText(value) === fallback
    default:
      return value === fallback
  }
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
