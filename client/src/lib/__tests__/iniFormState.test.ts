import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildIniSavePayload,
  mergeIniSchemaDefaults,
  parseIniNumber,
  parsePzBoolean,
  pzNumberHasStraySpace,
  pzNumberText,
  pzOptionText,
  showIniWhitespace,
} from '../iniFormState'
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

// GH#182 follow-up. GET /ini's rawSettings hands the form each value as the
// game reads it (not trimmed), and these readers apply the game's rules.
// Expectations recorded by running 42.21's ConfigFile.read and
// IntegerConfigOption/DoubleConfigOption.parse from projectzomboid.jar on the
// game's Java 25 runtime.
describe('pzOptionText', () => {
  it('keeps the start, trims the line end, and stops at the next "="', () => {
    expect(pzOptionText(' My Server')).toBe(' My Server')
    expect(pzOptionText('Hello = world')).toBe('Hello ')
    expect(pzOptionText('16 \t')).toBe('16')
  })
})

describe('parseIniNumber (Double.parseDouble)', () => {
  it.each([
    ['16', 16, 'plain'],
    [' 16', 16, 'MaxPlayers= 16: Double.parseDouble trims chars up to U+0020 itself'],
    ['\t16', 16, 'a tab is up to U+0020 too'],
    ['16 =x', 16, 'read up to the next "="'],
    ['\u00A016', null, 'a no-break space is not trimmed: the game keeps the default'],
    ['16\u00A0', null, 'not at the end either'],
    ['\uFEFF16', null, 'nor a BOM'],
    ['1\u20036', null, 'nor any other Unicode space'],
  ])('%j -> %s (%s)', (value, expected) => {
    expect(parseIniNumber(value, { min: 1, max: 254 })).toBe(expected)
  })

  it('still applies the panel\'s bounds and number rules', () => {
    expect(parseIniNumber(' 300', { min: 1, max: 254 })).toBeNull()
    expect(parseIniNumber(' 300', { min: 1, max: 254 }, { enforceBounds: false })).toBe(300)
    expect(parseIniNumber('abc')).toBeNull()
  })

  it('says when the only problem is a space the game does not trim', () => {
    expect(pzNumberHasStraySpace('\u00A0400')).toBe(true)
    expect(pzNumberHasStraySpace('400\uFEFF')).toBe(true)
    expect(pzNumberHasStraySpace(' 400')).toBe(false)
    expect(pzNumberHasStraySpace('abc')).toBe(false)
  })

  it('a select (an integer option in the game) matches " 2" to option 2', () => {
    expect(pzNumberText(' 2')).toBe('2')
    expect(pzNumberText('\u00A02')).toBe('\u00A02')
  })
})

describe('showIniWhitespace', () => {
  it('marks spaces and invisible chars, and leaves other text alone', () => {
    expect(showIniWhitespace(' true')).toBe('␣true')
    expect(showIniWhitespace('PVP ')).toBe('PVP␣')
    expect(showIniWhitespace('\u00A0400')).toBe('[U+00A0]400')
    expect(showIniWhitespace('\uFEFFversion')).toBe('[U+FEFF]version')
    expect(showIniWhitespace('Tabbed\t')).toBe('Tabbed[U+0009]')
    expect(showIniWhitespace('admin')).toBe('admin')
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

describe('mergeIniSchemaDefaults with lines the game skips (GET /ini misnamedKeys)', () => {
  it('shows the default for a schema key whose line the game skips, and leaves it out of a save until changed', () => {
    const { settings, defaultedKeys } = mergeIniSchemaDefaults(
      { PVP: 'false', Public: 'true', Custom: 'x' },
      { PVP: 'PVP ', Custom: 'Custom ' },
    )
    expect(settings.PVP).toBe('true')
    expect(settings.Public).toBe('true')
    expect(settings.Custom).toBe('x')
    expect([...defaultedKeys]).toEqual(expect.arrayContaining(['PVP', 'Custom']))
    expect(defaultedKeys.has('Public')).toBe(false)
    expect(buildIniSavePayload(settings, settings, defaultedKeys)).toEqual({ Public: 'true' })
  })

  it('reads raw values as the game does: no warning for " 16" or select " 2", one for a no-break space', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mergeIniSchemaDefaults({ MaxPlayers: ' 16', BadWordPolicy: ' 2' })
    expect(warn).not.toHaveBeenCalled()
    mergeIniSchemaDefaults({ PingLimit: '\u00A0400' })
    expect(warn).toHaveBeenCalledWith('[ServerConfig] PingLimit expected number, got "\u00A0400"')
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
