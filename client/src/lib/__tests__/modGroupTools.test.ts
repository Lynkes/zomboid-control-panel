import { describe, expect, it } from 'vitest'
import type { ModGroup } from '@/lib/api'
import {
  autoOrderMembers,
  buildGroupMembership,
  gatherGroup,
  groupDotClass,
  groupsOfMods,
  isContiguous,
  memberPositions,
  memberTier,
  moveGroupBlock,
  moveGroupBlockTo,
  nameWords,
  summarizeGroupConflicts,
} from '../modGroupTools'

const group = (id: string, modIds: string[], extra: Partial<ModGroup> = {}): ModGroup => ({
  id,
  name: id,
  description: '',
  modIds,
  createdAt: '',
  updatedAt: '',
  color: null,
  keepTogether: false,
  ...extra,
})

describe('group colours', () => {
  it('maps a known colour to its dot and anything else to a hollow ring', () => {
    expect(groupDotClass('teal')).toBe('bg-teal-400')
    expect(groupDotClass(null)).toContain('ring-1')
    expect(groupDotClass('chartreuse')).toContain('ring-1')
  })
})

describe('membership', () => {
  it('lists every group a mod is in, in the groups\' own order, once each', () => {
    const a = group('a', ['X', 'Y'])
    const b = group('b', ['Y', 'Z', 'Y'])
    const membership = buildGroupMembership([a, b])
    expect(membership.get('Y')?.map((g) => g.id)).toEqual(['a', 'b'])
    expect(groupsOfMods(['Z', 'Y', 'X'], membership).map((g) => g.id)).toEqual(['a', 'b'])
    expect(groupsOfMods(['Q'], membership)).toEqual([])
  })
})

describe('conflicts per group', () => {
  it('counts conflicts inside a group and with mods outside it, and lists every mod involved', () => {
    const pair = (a: string, b: string) => ({ modA: { modId: a }, modB: { modId: b } })
    const summary = summarizeGroupConflicts(
      [group('ki5', ['K1', 'K2']), group('quiet', ['Q'])],
      [pair('K1', 'K2'), pair('K2', 'Other'), pair('X', 'Y')],
    )
    expect(summary.get('ki5')).toEqual({ internal: 1, external: 1, modIds: ['K1', 'K2', 'Other'] })
    expect(summary.has('quiet')).toBe(false)
  })
})

describe('auto-order members', () => {
  it('splits IDs and names into words, camelCase included', () => {
    expect(nameWords('KI5LibraryB42 - Core_Fix')).toEqual(['ki5', 'library', 'b42', 'core', 'fix'])
    expect(nameWords('TchernoLib')).toEqual(['tcherno', 'lib'])
  })

  it('puts libraries first and fixes last, add-ons between', () => {
    expect(memberTier('KI5Library')).toBe(0)
    expect(memberTier('KI5Core')).toBe(0)
    expect(memberTier('KI5Vehicles')).toBe(1)
    expect(memberTier('KI5AddOn')).toBe(2)
    expect(memberTier('KI5_Expanded')).toBe(2)
    expect(memberTier('X', 'Brita Weapon Pack')).toBe(2)
    expect(memberTier('KI5Fixes')).toBe(3)
    expect(memberTier('X', 'Compatibility patch for Y')).toBe(3)
  })

  it('orders a vehicle pack library, core, add-ons, fixes and keeps ties as they are', () => {
    const result = autoOrderMembers(['KI5Fixes', 'Truck', 'KI5AddOn', 'Car', 'KI5Library'])
    expect(result.order).toEqual(['KI5Library', 'Truck', 'Car', 'KI5AddOn', 'KI5Fixes'])
    expect(result.changed).toBe(true)
  })

  it('a requirement between members wins over the name heuristic', () => {
    const result = autoOrderMembers(['Fixes', 'Core'], { requires: new Map([['Core', ['Fixes']]]) })
    expect(result.order).toEqual(['Fixes', 'Core'])
    expect(result.requirements).toBe(1)
  })

  it('uses display names too, and survives a requirement cycle', () => {
    const result = autoOrderMembers(['B', 'A'], {
      names: { A: 'Shared Library' },
      requires: new Map([['A', ['B']], ['B', ['A']]]),
    })
    expect(result.order).toHaveLength(2)
    expect(new Set(result.order)).toEqual(new Set(['A', 'B']))
  })

  it('reports no change for an order that is already right', () => {
    expect(autoOrderMembers(['Lib', 'Main', 'Fix']).changed).toBe(false)
  })
})

describe('group blocks in the load order', () => {
  const order = ['A', 'K1', 'K2', 'K3', 'B', 'C']
  const ki5 = ['K1', 'K2', 'K3']

  it('finds where the members are and whether they are one run', () => {
    expect(memberPositions(order, ki5)).toEqual([1, 2, 3])
    expect(isContiguous([1, 2, 3])).toBe(true)
    expect(isContiguous([1, 3])).toBe(false)
  })

  it('moves the whole block to the top, up, down and to the bottom', () => {
    expect(moveGroupBlock(order, ki5, 'top')).toEqual(['K1', 'K2', 'K3', 'A', 'B', 'C'])
    expect(moveGroupBlock(order, ki5, 'up')).toEqual(['K1', 'K2', 'K3', 'A', 'B', 'C'])
    expect(moveGroupBlock(order, ki5, 'down')).toEqual(['A', 'B', 'K1', 'K2', 'K3', 'C'])
    expect(moveGroupBlock(order, ki5, 'bottom')).toEqual(['A', 'B', 'C', 'K1', 'K2', 'K3'])
  })

  it('does nothing at an edge, or for members that are not one run', () => {
    expect(moveGroupBlock(['K1', 'K2', 'A'], ['K1', 'K2'], 'top')).toBeNull()
    expect(moveGroupBlock(['K1', 'K2', 'A'], ['K1', 'K2'], 'up')).toBeNull()
    expect(moveGroupBlock(['A', 'K1', 'K2'], ['K1', 'K2'], 'down')).toBeNull()
    expect(moveGroupBlock(['K1', 'A', 'K2'], ['K1', 'K2'], 'down')).toBeNull()
  })

  it('jumps over a neighbouring block as a whole', () => {
    const withBlocks = ['X1', 'X2', 'K1', 'K2', 'A']
    const unitAt = (index: number) => (index <= 1 ? ([0, 1] as const) : null)
    expect(moveGroupBlock(withBlocks, ['K1', 'K2'], 'up', unitAt)).toEqual(['K1', 'K2', 'X1', 'X2', 'A'])
  })

  it('drops a dragged block at a new slot', () => {
    expect(moveGroupBlockTo(order, ki5, 3)).toEqual(['A', 'B', 'C', 'K1', 'K2', 'K3'])
    expect(moveGroupBlockTo(order, ki5, 0)).toEqual(['K1', 'K2', 'K3', 'A', 'B', 'C'])
    expect(moveGroupBlockTo(order, ki5, 1)).toBeNull()
  })

  it('gathers a group at its first member, in group order, the mods between following it', () => {
    expect(gatherGroup(['A', 'K2', 'B', 'K1', 'C', 'K3'], ki5)).toEqual(['A', 'K1', 'K2', 'K3', 'B', 'C'])
    expect(gatherGroup(['A', 'B'], ki5)).toEqual(['A', 'B'])
  })
})
