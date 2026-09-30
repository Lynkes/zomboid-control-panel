import { describe, expect, it } from 'vitest'
import type { CharacterContainerRow, CharacterHint, CharacterRow, CharacterStackRow } from '@/lib/characterApi'
import {
  aggregateByType,
  aggregateRows,
  countUnits,
  filterTree,
  inventoryAnnotations,
  matchingRows,
  rowMatches,
  sortRows,
  totals,
} from '@/lib/characterInventory'

function stack(fullType: string, extra: Partial<CharacterStackRow> = {}): CharacterStackRow {
  return { kind: 'stack', fullType, name: fullType.split('.')[1], qty: 1, ...extra }
}

function bag(name: string, rows: CharacterRow[], extra: Partial<CharacterContainerRow> = {}): CharacterContainerRow {
  return { kind: 'container', fullType: `Base.${name}`, name, rows, ...extra }
}

const tree: CharacterRow[] = [
  stack('Base.Hammer', { weight: 1, condition: 9, conditionMax: 10, equipped: 'primary' }),
  stack('Base.Nails', { qty: 120, weight: 1.2, modId: 'pz-vanilla' }),
  bag('Schoolbag', [stack('Base.Nails', { qty: 30, weight: 0.3 }), bag('Pouch', [stack('Base.Ring', { modId: 'JewelryMod' })])], {
    weight: 3,
    worn: true,
  }),
]

describe('countUnits / totals', () => {
  it('counts stack quantities and each container once, recursively', () => {
    // Hammer 1 + Nails 120 + Schoolbag 1 + Nails 30 + Pouch 1 + Ring 1
    expect(countUnits(tree)).toBe(154)
  })

  it('totals units, distinct types and top-level weight', () => {
    expect(totals(tree)).toEqual({ units: 154, types: 5, weight: 5.2 })
    expect(totals([])).toEqual({ units: 0, types: 0, weight: 0 })
  })
})

describe('rowMatches / filterTree', () => {
  it('matches on name, full type or mod id, ignoring case', () => {
    expect(rowMatches(stack('Base.Nails'), 'nail')).toBe(true)
    expect(rowMatches(stack('Base.Nails'), 'BASE.NA')).toBe(true)
    expect(rowMatches(stack('Base.Ring', { modId: 'JewelryMod' }), 'jewelry')).toBe(true)
    expect(rowMatches(stack('Base.Ring'), 'hammer')).toBe(false)
  })

  it('keeps the ancestors of a nested match and counts only matched units', () => {
    const { rows, units } = filterTree(tree, 'ring')
    expect(rows).toHaveLength(1)
    const schoolbag = rows[0] as CharacterContainerRow
    expect(schoolbag.name).toBe('Schoolbag')
    expect(schoolbag.rows).toHaveLength(1)
    const pouch = schoolbag.rows[0] as CharacterContainerRow
    expect(pouch.name).toBe('Pouch')
    expect(pouch.rows.map((r) => r.fullType)).toEqual(['Base.Ring'])
    expect(units).toBe(1)
  })

  it('a container that matches keeps all of its contents', () => {
    const { rows, units } = filterTree(tree, 'schoolbag')
    expect((rows[0] as CharacterContainerRow).rows).toHaveLength(2)
    expect(units).toBe(33) // the bag, 30 nails, the pouch, the ring
  })

  it('finds matches at every level and sums them', () => {
    const { rows, units } = filterTree(tree, 'nails')
    expect(rows.map((r) => r.name)).toEqual(['Nails', 'Schoolbag'])
    expect(units).toBe(150)
  })

  it('an empty query returns the tree untouched', () => {
    const result = filterTree(tree, '   ')
    expect(result.rows).toBe(tree)
    expect(result.units).toBe(154)
  })

  it('nothing matching gives an empty list', () => {
    expect(filterTree(tree, 'zzz')).toEqual({ rows: [], units: 0 })
  })
})

describe('aggregateByType', () => {
  it('merges one type across containers and keeps its flags', () => {
    const nails = aggregateByType(tree).find((entry) => entry.fullType === 'Base.Nails')!
    expect(nails).toMatchObject({ qty: 150, rows: 2, weight: 1.5, modId: 'pz-vanilla' })
    const hammer = aggregateByType(tree).find((entry) => entry.fullType === 'Base.Hammer')!
    expect(hammer).toMatchObject({ qty: 1, equipped: true, lowestCondition: 9, conditionMax: 10 })
    const schoolbag = aggregateByType(tree).find((entry) => entry.fullType === 'Base.Schoolbag')!
    expect(schoolbag).toMatchObject({ qty: 1, worn: true })
  })

  it('flags hidden and obsolete types', () => {
    const [entry] = aggregateByType([stack('Base.Secret', { hidden: true }), stack('Base.Secret', { obsolete: true })])
    expect(entry).toMatchObject({ qty: 2, hidden: true, obsolete: true })
  })
})

describe('matchingRows (the By type search)', () => {
  const bags: CharacterRow[] = [
    bag('Alpha Bag', [stack('Base.Nails', { qty: 3 })]),
    bag('Beta Bag', [stack('Base.Axe')]),
  ]

  it('keeps only matching rows: no ancestor bag, no contents of a matching bag', () => {
    expect(aggregateRows(matchingRows(bags, 'axe')).map((entry) => entry.fullType)).toEqual(['Base.Axe'])
    expect(aggregateRows(matchingRows(bags, 'Alpha')).map((entry) => [entry.fullType, entry.qty])).toEqual([['Base.Alpha Bag', 1]])
  })

  it('an empty query is every row, as aggregateByType counts them', () => {
    expect(aggregateRows(matchingRows(tree, ''))).toEqual(aggregateByType(tree))
  })
})

describe('sortRows', () => {
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

  it('sorts by name with the collator, containers included', () => {
    const sorted = sortRows(tree, 'name', collator)
    expect(sorted.map((r) => r.name)).toEqual(['Hammer', 'Nails', 'Schoolbag'])
    expect((sorted[2] as CharacterContainerRow).rows.map((r) => r.name)).toEqual(['Nails', 'Pouch'])
  })

  it('sorts by quantity or weight, largest first, name as the tie-break', () => {
    expect(sortRows(tree, 'qty', collator).map((r) => r.name)).toEqual(['Nails', 'Hammer', 'Schoolbag'])
    expect(sortRows(tree, 'weight', collator).map((r) => r.name)).toEqual(['Schoolbag', 'Nails', 'Hammer'])
  })

  it('does not change the input', () => {
    const copy = JSON.stringify(tree)
    sortRows(tree, 'name', collator)
    expect(JSON.stringify(tree)).toBe(copy)
  })
})

describe('inventoryAnnotations', () => {
  it('marks debug items and panel gifts from hint evidence', () => {
    const hints: CharacterHint[] = [
      {
        id: 'debugItems',
        weight: 'strong',
        params: {},
        staff: false,
        source: 'live',
        evidence: [{ kind: 'item', ref: 'Base.TestMug', detail: { qty: 1, given: 1, givenAt: '2026-09-29T10:00:00.000Z' } }],
        explainedBy: [{ action: 'add_item', at: '2026-09-29T10:00:00.000Z', details: 'Base.TestMug x1' }],
      },
      { id: 'overCapacity', weight: 'strong', params: {}, staff: false, source: 'live', evidence: [] },
    ]
    const map = inventoryAnnotations(hints)
    expect(map.get('Base.TestMug')).toEqual({ debug: true, givenAt: '2026-09-29T10:00:00.000Z', given: 1, qty: 1 })
    expect(map.size).toBe(1)
    expect(inventoryAnnotations(undefined).size).toBe(0)
  })

  it('says how many of how many when the panel gave only part of the stack', () => {
    const partial: CharacterHint = {
      id: 'debugItems',
      weight: 'strong',
      params: {},
      staff: false,
      source: 'live',
      evidence: [{ kind: 'item', ref: 'Base.TestMug', detail: { qty: 5, given: 1, givenAt: '2026-09-29T10:00:00.000Z' } }],
    }
    expect(inventoryAnnotations([partial]).get('Base.TestMug')).toEqual({
      debug: true,
      givenAt: '2026-09-29T10:00:00.000Z',
      given: 1,
      qty: 5,
    })
  })
})
