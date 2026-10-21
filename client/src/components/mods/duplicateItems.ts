import type { ModHealth, ModHealthFix, ModHealthIssue } from '@/lib/api'

/** Mod IDs that two or more Workshop items both ship. */
export interface DuplicateItemSet {
  /** The sorted Workshop item IDs, joined: one entry per set of items. */
  key: string
  /** In WorkshopItems= order. */
  workshopIds: string[]
  modIds: string[]
}

/**
 * Groups "mod ID -> the Workshop items that ship it" per set of items: a fork
 * installed next to its original (both shipping the same four IDs) is one
 * entry naming both items and the four IDs, not four separate warnings.
 */
export function duplicateItemSets(providers: ReadonlyMap<string, readonly string[]>): DuplicateItemSet[] {
  const sets = new Map<string, DuplicateItemSet>()
  for (const [modId, wsIds] of providers) {
    const items = [...new Set(wsIds)]
    if (items.length < 2) continue
    const key = [...items].sort().join(',')
    let set = sets.get(key)
    if (!set) {
      set = { key, workshopIds: items, modIds: [] }
      sets.set(key, set)
    }
    set.modIds.push(modId)
  }
  return [...sets.values()]
}

/** The health check's duplicate issue for exactly these items, with its "Keep <item>" fixes. */
export function keepFixesFor(health: ModHealth | null | undefined, set: DuplicateItemSet): { issue: ModHealthIssue; fixes: ModHealthFix[] } | null {
  for (const issue of health?.issues ?? []) {
    if (issue.kind !== 'duplicateModId') continue
    if ([...issue.workshopIds].sort().join(',') !== set.key) continue
    const fixes = issue.fixes.filter((fix) => fix.action === 'removeWorkshopItems' && typeof fix.params?.keep === 'string')
    if (fixes.length > 0) return { issue, fixes }
  }
  return null
}
