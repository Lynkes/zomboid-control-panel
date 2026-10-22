import { modsApi, type ModGroup } from '@/lib/api'
import { readStored } from '@/lib/safeStorage'

/** Where a group's placement was kept before the server stored it (per browser). */
export const LEGACY_PLACEMENT_KEY = 'zcp:mods:groupPlacement'

export type GroupPlacement = 'first' | 'last'

export function readLegacyPlacements(): Record<string, GroupPlacement> {
  try {
    const parsed = JSON.parse(readStored(LEGACY_PLACEMENT_KEY) ?? '{}') as Record<string, unknown>
    const result: Record<string, GroupPlacement> = {}
    for (const [id, value] of Object.entries(parsed ?? {})) {
      if (value === 'first' || value === 'last') result[id] = value
    }
    return result
  } catch {
    return {}
  }
}

function dropLegacyKey() {
  try {
    localStorage.removeItem(LEGACY_PLACEMENT_KEY)
  } catch {
    // Storage blocked: nothing was readable there either.
  }
}

/**
 * One-time move of the placements this browser kept to the server: each group
 * the server has no placement for gets the stored one (PUT). The browser's key
 * is removed only once every PUT succeeded, so a failure is retried on the next
 * load. A group the server already places keeps the server's value.
 * Returns the ids of the groups updated and whether the key was removed.
 */
export async function migrateLegacyPlacements(
  groups: readonly ModGroup[],
  update: (id: string, patch: { placement: GroupPlacement }) => Promise<unknown> = (id, patch) => modsApi.updateGroup(id, patch),
): Promise<{ migrated: string[]; done: boolean }> {
  if (readStored(LEGACY_PLACEMENT_KEY) === null) return { migrated: [], done: true }
  const legacy = readLegacyPlacements()
  const pending = groups.filter((group) => (group.placement ?? null) === null && legacy[group.id])
  const migrated: string[] = []
  for (const group of pending) {
    try {
      await update(group.id, { placement: legacy[group.id] })
      migrated.push(group.id)
    } catch {
      return { migrated, done: false }
    }
  }
  dropLegacyKey()
  return { migrated, done: true }
}
