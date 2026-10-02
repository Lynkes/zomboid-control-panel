// Server Settings (server.ini) form state: what the structured editor shows
// for a loaded file, and what it sends back on save.

import { INI_SCHEMA } from './serverConfigSchema'

/**
 * Read a server.ini boolean the way PZ 42.21 does, given the text after the
 * line's first "=". zombie.config.ConfigFile.read trims the whole line (Java
 * String.trim: every char up to U+0020), splits it on "=" and keeps only the
 * piece after the first one; nothing trims that piece again. Then
 * BooleanConfigOption.parse takes "true"/"1" as on and "false"/"0" as off
 * (String.equalsIgnoreCase). Anything else is logged and dropped, so the
 * option keeps its default: B41's SteamScoreboard=admin, "Public= true",
 * "Public=true =x". Returns null for such a value.
 */
export function parsePzBoolean(value: string): boolean | null {
  // Only the line's end is trimmed, and that is this piece's end only when no
  // further "=" follows it.
  let end = value.indexOf('=')
  if (end === -1) {
    end = value.length
    while (end > 0 && value.charCodeAt(end - 1) <= 0x20) end--
  }
  const text = value.slice(0, end)
  // The u flag case-folds these words exactly as Java's equalsIgnoreCase
  // does (it also takes "falſe", with a long s, as the game does).
  if (/^(?:true|1)$/iu.test(text)) return true
  if (/^(?:false|0)$/iu.test(text)) return false
  return null
}

/** The INI form state for a loaded file. */
export interface LoadedIniForm {
  /** The file's own keys, plus a schema default for each non-legacy schema key it lacks. */
  settings: Record<string, string>
  /** The keys whose value came from the schema rather than the file. */
  defaultedKeys: Set<string>
}

/**
 * Fill every schema key the file lacks with its default, so the form can show
 * it, and record which ones were filled so a save leaves them out
 * (buildIniSavePayload). Legacy (Build 41-only) keys are never filled: the
 * form shows them only when the file has them. Also warns to the console when
 * a stored value doesn't parse for the schema type -- helps catch a corrupted
 * INI without changing behaviour.
 */
export function mergeIniSchemaDefaults(parsed: Record<string, string>): LoadedIniForm {
  const settings = { ...parsed }
  const defaultedKeys = new Set<string>()
  for (const setting of INI_SCHEMA) {
    if (!(setting.key in settings)) {
      if (setting.legacy) continue
      settings[setting.key] = String(setting.default ?? '')
      defaultedKeys.add(setting.key)
      continue
    }
    const raw = settings[setting.key]
    if (raw == null || raw === '') continue
    if (setting.type === 'boolean' && parsePzBoolean(raw) === null) {
      console.warn(`[ServerConfig] ${setting.key} expected boolean, got "${raw}"`)
    } else if (setting.type === 'number' && Number.isNaN(Number(raw))) {
      console.warn(`[ServerConfig] ${setting.key} expected number, got "${raw}"`)
    } else if (setting.type === 'select' && setting.options && !setting.options.some(o => o.value === raw)) {
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
