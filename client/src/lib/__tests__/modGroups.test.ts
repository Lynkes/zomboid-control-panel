import { describe, expect, it } from 'vitest'
import {
  MAX_GROUP_FILE_BYTES,
  buildGroupDocument,
  groupExportFileName,
  moveListEntry,
  parseGroupDocument,
  slugifyGroupName,
} from '../modGroups'

describe('slugifyGroupName / groupExportFileName', () => {
  it('turns a group name into a file-safe slug', () => {
    expect(slugifyGroupName('KI5 Vehicles')).toBe('ki5-vehicles')
    expect(slugifyGroupName('  Brita\'s Weapons & Armor!! ')).toBe('brita-s-weapons-armor')
    expect(slugifyGroupName('Véhicules Évolués')).toBe('vehicules-evolues')
  })

  it('keeps letters of other scripts and falls back when nothing is left', () => {
    expect(slugifyGroupName('载具包')).toBe('载具包')
    expect(slugifyGroupName('!!!')).toBe('group')
    expect(slugifyGroupName('')).toBe('group')
  })

  it('caps the slug and never leaves a trailing dash', () => {
    const slug = slugifyGroupName(`${'a'.repeat(47)} bbbbbb`)
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('names the export file zcp-mod-group-<slug>.json', () => {
    expect(groupExportFileName('KI5 Vehicles')).toBe('zcp-mod-group-ki5-vehicles.json')
  })
})

describe('buildGroupDocument', () => {
  it('builds the export document with only the shareable fields', () => {
    const doc = buildGroupDocument({ name: 'KI5 Vehicles', description: ' Library first ', modIds: ['A', 'B'] })
    expect(doc).toEqual({ schema: 1, kind: 'zcp-mod-group', name: 'KI5 Vehicles', description: 'Library first', modIds: ['A', 'B'] })
  })

  it('leaves the description out when it is empty', () => {
    expect(buildGroupDocument({ name: 'G', description: '  ', modIds: ['A'] })).toEqual({
      schema: 1,
      kind: 'zcp-mod-group',
      name: 'G',
      modIds: ['A'],
    })
  })

  it('copies the mod list instead of sharing it', () => {
    const modIds = ['A', 'B']
    const doc = buildGroupDocument({ name: 'G', description: '', modIds })
    modIds.push('C')
    expect(doc.modIds).toEqual(['A', 'B'])
  })
})

describe('parseGroupDocument', () => {
  const valid = { schema: 1, kind: 'zcp-mod-group', name: 'KI5 Vehicles', description: 'x', modIds: ['A', ' B '] }

  it('accepts a group export and returns a clean copy', () => {
    const parsed = parseGroupDocument(JSON.stringify({ ...valid, somethingElse: true }))
    expect(parsed).toEqual({
      ok: true,
      document: { schema: 1, kind: 'zcp-mod-group', name: 'KI5 Vehicles', description: 'x', modIds: ['A', 'B'] },
    })
  })

  it('round-trips what Export writes', () => {
    const doc = buildGroupDocument({ name: 'Round trip', description: 'd', modIds: ['A', 'B', 'C'] })
    expect(parseGroupDocument(JSON.stringify(doc, null, 2))).toEqual({ ok: true, document: doc })
  })

  it('rejects text that is not JSON, or JSON that is not an object', () => {
    expect(parseGroupDocument('not json')).toEqual({ ok: false, problem: 'notJson' })
    expect(parseGroupDocument('[1,2]')).toEqual({ ok: false, problem: 'notJson' })
    expect(parseGroupDocument('null')).toEqual({ ok: false, problem: 'notJson' })
  })

  it('rejects another kind of document', () => {
    expect(parseGroupDocument(JSON.stringify({ ...valid, kind: 'zcp-mod-preset' }))).toEqual({ ok: false, problem: 'wrongKind' })
    expect(parseGroupDocument(JSON.stringify({ name: 'x', modIds: ['A'] }))).toEqual({ ok: false, problem: 'wrongKind' })
  })

  it('rejects a schema this panel does not know', () => {
    expect(parseGroupDocument(JSON.stringify({ ...valid, schema: 2 }))).toEqual({ ok: false, problem: 'unsupportedSchema' })
    expect(parseGroupDocument(JSON.stringify({ ...valid, schema: undefined }))).toEqual({ ok: false, problem: 'unsupportedSchema' })
  })

  it('rejects a missing name or a missing, empty or non-string mod list', () => {
    expect(parseGroupDocument(JSON.stringify({ ...valid, name: '  ' }))).toEqual({ ok: false, problem: 'invalid' })
    expect(parseGroupDocument(JSON.stringify({ ...valid, modIds: [] }))).toEqual({ ok: false, problem: 'invalid' })
    expect(parseGroupDocument(JSON.stringify({ ...valid, modIds: 'A,B' }))).toEqual({ ok: false, problem: 'invalid' })
    expect(parseGroupDocument(JSON.stringify({ ...valid, modIds: ['A', 7] }))).toEqual({ ok: false, problem: 'invalid' })
    expect(parseGroupDocument(JSON.stringify({ ...valid, modIds: ['A', ' '] }))).toEqual({ ok: false, problem: 'invalid' })
  })

  it('rejects a file far larger than any group', () => {
    expect(parseGroupDocument(' '.repeat(MAX_GROUP_FILE_BYTES + 1))).toEqual({ ok: false, problem: 'tooLarge' })
  })
})

describe('moveListEntry', () => {
  it('moves an entry to a new slot without touching the input', () => {
    const list = ['A', 'B', 'C', 'D']
    expect(moveListEntry(list, 1, 3)).toEqual(['A', 'C', 'D', 'B'])
    expect(moveListEntry(list, 3, 0)).toEqual(['D', 'A', 'B', 'C'])
    expect(list).toEqual(['A', 'B', 'C', 'D'])
  })

  it('returns the same list when there is nowhere to move to', () => {
    const list = ['A', 'B']
    expect(moveListEntry(list, 0, 0)).toBe(list)
    expect(moveListEntry(list, 0, -1)).toBe(list)
    expect(moveListEntry(list, 1, 2)).toBe(list)
  })
})
