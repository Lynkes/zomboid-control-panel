import { describe, expect, it } from 'vitest'
import type { TrackedMod, WsGroup } from '@/lib/modsShared'
import {
  ALL_GROUPS,
  filterActiveItems,
  filterInstalledMods,
  matchesActiveSearch,
  parseGroupFilter,
  sortActiveItems,
  sortInstalledMods,
  type ActiveFilters,
  type ActiveLookups,
} from '../modListFilters'

const tracked = (workshop_id: string, name: string, extra: Partial<TrackedMod> = {}): TrackedMod => ({
  id: Number(workshop_id),
  workshop_id,
  name,
  last_updated: '2026-01-01T00:00:00.000Z',
  last_checked: null,
  update_available: 0,
  created_at: '',
  ...extra,
})

const notes: Record<string, string> = { '2': 'Keep on 1.2 until the patch lands' }
const groupsOf: Record<string, string[]> = { '1': ['ki5'], '3': ['ki5', 'fixes'] }
const lookups = {
  noteText: (id: string) => notes[id] ?? '',
  groupIdsOf: (id: string) => groupsOf[id] ?? [],
}

describe('Installed list', () => {
  const mods = [
    tracked('1', 'KI5 Library', { last_updated: '2026-03-01T00:00:00.000Z' }),
    tracked('2', 'Authentic Z', { update_available: 1, last_updated: '2026-05-01T00:00:00.000Z' }),
    tracked('3', 'KI5 Fixes', { last_updated: '2026-04-01T00:00:00.000Z' }),
    tracked('4', 'Brita'),
  ]
  const none = { updatesOnly: false, hasNote: false, group: ALL_GROUPS }

  it('searches names, Workshop IDs and notes', () => {
    expect(filterInstalledMods(mods, 'ki5', none, lookups).map((m) => m.workshop_id)).toEqual(['1', '3'])
    expect(filterInstalledMods(mods, 'patch lands', none, lookups).map((m) => m.workshop_id)).toEqual(['2'])
    expect(filterInstalledMods(mods, '4', none, lookups).map((m) => m.workshop_id)).toEqual(['4'])
  })

  it('combines the status, note and group filters', () => {
    expect(filterInstalledMods(mods, '', { ...none, updatesOnly: true }, lookups).map((m) => m.workshop_id)).toEqual(['2'])
    expect(filterInstalledMods(mods, '', { ...none, hasNote: true }, lookups).map((m) => m.workshop_id)).toEqual(['2'])
    expect(filterInstalledMods(mods, '', { ...none, group: { kind: 'ungrouped' } }, lookups).map((m) => m.workshop_id)).toEqual(['2', '4'])
    expect(filterInstalledMods(mods, '', { ...none, group: { kind: 'group', groupId: 'fixes' } }, lookups).map((m) => m.workshop_id)).toEqual(['3'])
  })

  it('sorts by status, name or most recently updated', () => {
    expect(sortInstalledMods(mods, 'status').map((m) => m.workshop_id)).toEqual(['2', '4', '3', '1'])
    expect(sortInstalledMods(mods, 'name').map((m) => m.workshop_id)).toEqual(['2', '4', '3', '1'])
    expect(sortInstalledMods(mods, 'updated').map((m) => m.workshop_id)).toEqual(['2', '3', '1', '4'])
  })
})

describe('Active on server list', () => {
  const item = (wsId: string, mods: Array<[string, string, boolean]>): WsGroup => {
    const entries = mods.map(([id, name, enabled]) => ({ id, name, enabled }))
    return { wsId, mods: entries, allEnabled: entries.every((m) => m.enabled), someEnabled: entries.some((m) => m.enabled) }
  }
  const items = [
    item('1', [['KI5Lib', 'KI5 Library', true]]),
    item('2', [['AuthZ', 'Authentic Z', true], ['AuthZBags', 'Authentic Z Backpacks', false]]),
    item('3', [['KI5Fix', 'KI5 Fixes', true]]),
    item('4', [['Brita', 'Brita', false]]),
  ]
  const active: ActiveLookups = {
    ...lookups,
    needsAttention: (g) => g.wsId === '4',
    hasUpdate: (id) => id === '2',
    hasMissingDep: (g) => g.wsId === '3',
  }
  const none: ActiveFilters = { attention: false, multiId: false, notEnabled: false, updates: false, missingDep: false, hasNote: false, group: ALL_GROUPS }
  const ids = (list: WsGroup[]) => list.map((g) => g.wsId)

  it('narrows a multi-ID item to the mod IDs that match, and matches notes', () => {
    expect(matchesActiveSearch(items[1], 'backpacks', lookups.noteText)?.mods.map((m) => m.id)).toEqual(['AuthZBags'])
    expect(matchesActiveSearch(items[1], 'patch lands', lookups.noteText)).toBe(items[1])
    expect(matchesActiveSearch(items[0], 'nothing', lookups.noteText)).toBeNull()
  })

  it('applies every chip', () => {
    expect(ids(filterActiveItems(items, { ...none, multiId: true }, active))).toEqual(['2'])
    expect(ids(filterActiveItems(items, { ...none, notEnabled: true }, active))).toEqual(['2', '4'])
    expect(ids(filterActiveItems(items, { ...none, attention: true }, active))).toEqual(['4'])
    expect(ids(filterActiveItems(items, { ...none, updates: true }, active))).toEqual(['2'])
    expect(ids(filterActiveItems(items, { ...none, missingDep: true }, active))).toEqual(['3'])
    expect(ids(filterActiveItems(items, { ...none, hasNote: true }, active))).toEqual(['2'])
    expect(ids(filterActiveItems(items, { ...none, group: { kind: 'group', groupId: 'ki5' } }, active))).toEqual(['1', '3'])
    expect(ids(filterActiveItems(items, { ...none, notEnabled: true, group: { kind: 'ungrouped' } }, active))).toEqual(['2', '4'])
  })

  it('sorts by config order, load order, name or update time', () => {
    const sortLookups = {
      loadIndex: (g: WsGroup) => ({ '1': 3, '2': 0, '3': 1 } as Record<string, number>)[g.wsId] ?? Infinity,
      name: (g: WsGroup) => g.mods[0].name,
      updatedAt: (id: string) => Number(id),
    }
    expect(ids(sortActiveItems(items, 'config', sortLookups))).toEqual(['1', '2', '3', '4'])
    expect(ids(sortActiveItems(items, 'loadOrder', sortLookups))).toEqual(['2', '3', '1', '4'])
    expect(ids(sortActiveItems(items, 'name', sortLookups))).toEqual(['2', '4', '3', '1'])
    expect(ids(sortActiveItems(items, 'updated', sortLookups))).toEqual(['4', '3', '2', '1'])
  })
})

describe('remembered group filter', () => {
  it('reads back a stored filter and forgets one whose group is gone', () => {
    expect(parseGroupFilter({ kind: 'group', groupId: 'ki5' }, ['ki5'])).toEqual({ kind: 'group', groupId: 'ki5' })
    expect(parseGroupFilter({ kind: 'group', groupId: 'deleted' }, ['ki5'])).toEqual(ALL_GROUPS)
    expect(parseGroupFilter({ kind: 'ungrouped' }, [])).toEqual({ kind: 'ungrouped' })
    expect(parseGroupFilter('junk', [])).toEqual(ALL_GROUPS)
  })
})
