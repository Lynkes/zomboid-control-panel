import type { CharacterContainerRow, CharacterHint, CharacterRow } from '@/lib/characterApi'

// Pure helpers for the Character tab's inventory: search over the tree,
// the by-type view, totals and sorting. A stack row stands for `qty` units
// of one item type; a container is one unit of its own type plus whatever
// it holds.

function unitsOfStack(row: CharacterRow): number {
  return row.kind === 'stack' ? (typeof row.qty === 'number' ? row.qty : 1) : 1
}

/** Every unit in these rows, containers and their contents included. */
export function countUnits(rows: CharacterRow[]): number {
  let units = 0
  for (const row of rows) {
    units += unitsOfStack(row)
    if (row.kind === 'container') units += countUnits(row.rows)
  }
  return units
}

export function rowMatches(row: CharacterRow, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return true
  const fields = [row.name, row.fullType, row.kind === 'stack' ? row.modId : undefined]
  return fields.some((field) => typeof field === 'string' && field.toLocaleLowerCase().includes(q))
}

/**
 * Rows matching `query` (name, full type or mod id), keeping every ancestor
 * container of a match so its place in the tree stays visible. A container
 * that matches itself keeps all of its contents. `units` counts the matched
 * units only, not the ancestors kept for context.
 */
export function filterTree(rows: CharacterRow[], query: string): { rows: CharacterRow[]; units: number } {
  if (!query.trim()) return { rows, units: countUnits(rows) }
  const out: CharacterRow[] = []
  let units = 0
  for (const row of rows) {
    if (rowMatches(row, query)) {
      out.push(row)
      units += unitsOfStack(row) + (row.kind === 'container' ? countUnits(row.rows) : 0)
      continue
    }
    if (row.kind === 'container') {
      const inner = filterTree(row.rows, query)
      if (inner.rows.length > 0) {
        out.push({ ...row, rows: inner.rows })
        units += inner.units
      }
    }
  }
  return { rows: out, units }
}

export interface InventoryTypeAggregate {
  key: string
  fullType?: string
  name?: string
  category?: string
  modId?: string
  qty: number
  weight: number
  /** Stack rows and containers of this type across the tree. */
  rows: number
  hidden: boolean
  obsolete: boolean
  worn: boolean
  equipped: boolean
  lowestCondition?: number
  conditionMax?: number
}

export function flattenRows(rows: CharacterRow[], out: CharacterRow[] = []): CharacterRow[] {
  for (const row of rows) {
    out.push(row)
    if (row.kind === 'container') flattenRows(row.rows, out)
  }
  return out
}

/** One entry per item type across every container, for the "By type" view. */
export function aggregateByType(rows: CharacterRow[]): InventoryTypeAggregate[] {
  const byKey = new Map<string, InventoryTypeAggregate>()
  for (const row of flattenRows(rows)) {
    const key = row.fullType ?? `name:${row.name ?? ''}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        key,
        fullType: row.fullType,
        name: row.name,
        qty: 0,
        weight: 0,
        rows: 0,
        hidden: false,
        obsolete: false,
        worn: false,
        equipped: false,
      }
      byKey.set(key, entry)
    }
    entry.qty += unitsOfStack(row)
    entry.rows += 1
    if (typeof row.weight === 'number') entry.weight += row.weight
    if (row.worn) entry.worn = true
    if (row.equipped) entry.equipped = true
    if (row.kind === 'stack') {
      entry.category ??= row.category
      entry.modId ??= row.modId
      if (row.hidden) entry.hidden = true
      if (row.obsolete) entry.obsolete = true
      if (typeof row.condition === 'number' && (entry.lowestCondition === undefined || row.condition < entry.lowestCondition)) {
        entry.lowestCondition = row.condition
        entry.conditionMax = row.conditionMax
      }
    }
  }
  return [...byKey.values()]
}

export interface InventoryTotals {
  units: number
  types: number
  weight: number
}

export function totals(rows: CharacterRow[]): InventoryTotals {
  const flat = flattenRows(rows)
  const types = new Set(flat.map((row) => row.fullType ?? `name:${row.name ?? ''}`))
  // Only top-level weights: a container's own weight already includes what
  // it holds in Project Zomboid's accounting.
  const weight = rows.reduce((sum, row) => sum + (typeof row.weight === 'number' ? row.weight : 0), 0)
  return { units: countUnits(rows), types: types.size, weight }
}

export type InventorySortKey = 'name' | 'qty' | 'weight'

interface Sortable {
  name?: string
  fullType?: string
  qty?: number
  weight?: number
}

function sortValue(item: Sortable, key: InventorySortKey): number {
  if (key === 'qty') return typeof item.qty === 'number' ? item.qty : 1
  return typeof item.weight === 'number' ? item.weight : 0
}

/**
 * Sorted copy: by name (collator order), or by quantity/weight, largest
 * first with the name as tie-break. Containers' contents are sorted too.
 */
export function sortRows<T extends Sortable>(items: T[], key: InventorySortKey, collator: Intl.Collator): T[] {
  const byName = (a: T, b: T) => collator.compare(a.name ?? a.fullType ?? '', b.name ?? b.fullType ?? '')
  const sorted = [...items].sort((a, b) =>
    key === 'name' ? byName(a, b) : sortValue(b, key) - sortValue(a, key) || byName(a, b),
  )
  return sorted.map((item) => {
    const row = item as unknown as CharacterRow
    if (row && typeof row === 'object' && row.kind === 'container') {
      return { ...row, rows: sortRows(row.rows, key, collator) } as CharacterContainerRow as unknown as T
    }
    return item
  })
}

export interface InventoryAnnotation {
  debug?: boolean
  givenAt?: string
}

/** Per item type: flagged as a debug item, or given through the panel. */
export function inventoryAnnotations(hints: CharacterHint[] | undefined): Map<string, InventoryAnnotation> {
  const map = new Map<string, InventoryAnnotation>()
  for (const hint of hints ?? []) {
    for (const evidence of hint.evidence) {
      if (evidence.kind !== 'item') continue
      const entry = map.get(evidence.ref) ?? {}
      if (hint.id === 'debugItems') entry.debug = true
      if (evidence.detail?.givenAt) entry.givenAt = evidence.detail.givenAt
      map.set(evidence.ref, entry)
    }
  }
  return map
}
