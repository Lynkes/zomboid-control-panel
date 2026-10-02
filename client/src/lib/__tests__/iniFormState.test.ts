import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIniSavePayload, mergeIniSchemaDefaults, parsePzBoolean } from '../iniFormState'
import { INI_SCHEMA } from '../serverConfigSchema'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parsePzBoolean (zombie.config.BooleanConfigOption)', () => {
  it('reads true/false/1/0 in any case, and nothing else', () => {
    expect(['true', 'TRUE', '1', 'True'].map(parsePzBoolean)).toEqual([true, true, true, true])
    expect(['false', 'False', '0'].map(parsePzBoolean)).toEqual([false, false, false])
    expect(['admin', 'yes', '', '2', '01'].map(parsePzBoolean)).toEqual([null, null, null, null, null])
  })

  // Each row is the text after "Key=" and what 42.21's own ConfigFile.read +
  // BooleanConfigOption made of that line (run against projectzomboid.jar on
  // the game's Java 25 runtime). null: the game logged it and kept the default.
  it.each([
    [' true', null, 'Public= true: the line is trimmed, the value after "=" is not'],
    ['  True  ', null, 'only the line end is trimmed'],
    ['true ', true, 'trailing space is the line end'],
    ['true\u0001', true, 'Java trims every char up to U+0020 at the line end'],
    ['\u0001true', null, 'a leading control char stays'],
    ['true\u00A0', null, 'Java trim leaves a no-break space'],
    ['true=x', true, 'ConfigFile.read splits on every "=" and keeps the piece after the first'],
    ['true=', true, 'a trailing "=" leaves the same piece'],
    ['true =x', null, 'that piece is not trimmed'],
    ['=true', null, 'Public==true reads as an empty value'],
    ['fal\u017Fe', false, 'equalsIgnoreCase folds a long s to s'],
  ])('%j -> %s (%s)', (value, expected) => {
    expect(parsePzBoolean(value)).toBe(expected)
  })
})

describe('mergeIniSchemaDefaults', () => {
  it('fills a missing key with its default and records it as defaulted', () => {
    const { settings, defaultedKeys } = mergeIniSchemaDefaults({ PublicName: 'Mine' })
    expect(settings.PublicName).toBe('Mine')
    expect(settings.Public).toBe('false')
    expect(settings.ShowCoordinates).toBe('false')
    expect(defaultedKeys.has('Public')).toBe(true)
    expect(defaultedKeys.has('PublicName')).toBe(false)
  })

  it('never fills a Build 41-only key, and keeps one the file has', () => {
    const legacyKeys = INI_SCHEMA.filter((s) => s.legacy).map((s) => s.key)
    expect(legacyKeys.length).toBeGreaterThan(0)

    const fresh = mergeIniSchemaDefaults({})
    for (const key of legacyKeys) {
      expect(fresh.settings).not.toHaveProperty(key)
      expect(fresh.defaultedKeys.has(key)).toBe(false)
    }

    const b41 = mergeIniSchemaDefaults({ PingFrequency: '15' })
    expect(b41.settings.PingFrequency).toBe('15')
    expect(b41.defaultedKeys.has('PingFrequency')).toBe(false)
  })

  it('does not warn about a boolean the game accepts as 1/0, only about one it rejects', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mergeIniSchemaDefaults({ PVP: '1', Open: '0' })
    expect(warn).not.toHaveBeenCalled()
    mergeIniSchemaDefaults({ SteamScoreboard: 'admin' })
    expect(warn).toHaveBeenCalledWith('[ServerConfig] SteamScoreboard expected boolean, got "admin"')
  })
})

describe('buildIniSavePayload', () => {
  const loaded = { PublicName: 'Mine', PVP: 'true', Public: 'false', ShowCoordinates: 'false' }
  const defaulted = new Set(['Public', 'ShowCoordinates'])

  it('leaves out a defaulted key the operator did not change, and sends every key the file has', () => {
    expect(buildIniSavePayload({ ...loaded, PublicName: 'Other' }, loaded, defaulted)).toEqual({
      PublicName: 'Other',
      PVP: 'true',
    })
  })

  it('sends a defaulted key once the operator changes it', () => {
    expect(buildIniSavePayload({ ...loaded, ShowCoordinates: 'true' }, loaded, defaulted)).toEqual({
      PublicName: 'Mine',
      PVP: 'true',
      ShowCoordinates: 'true',
    })
  })

  it('still sends a file key that was cleared', () => {
    expect(buildIniSavePayload({ ...loaded, PublicName: '' }, loaded, defaulted)).toMatchObject({ PublicName: '' })
  })

  it('round-trips a whole B42-shaped load unchanged: nothing but the file\'s keys goes back', () => {
    const file = { PublicName: 'Mine', PVP: 'true', DefaultPort: '16261' }
    const { settings, defaultedKeys } = mergeIniSchemaDefaults(file)
    expect(buildIniSavePayload(settings, settings, defaultedKeys)).toEqual(file)
  })
})
