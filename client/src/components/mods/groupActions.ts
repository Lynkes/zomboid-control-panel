import { modsApi, type ModGroup } from '@/lib/api'
import type { ModGroupDialogValues } from './ModGroupDialog'
import type { ModGroupsStore } from './useModGroupsStore'

/** Fewer than this and a group orders nothing (the dialog's rule too). */
export const MIN_MEMBERS = 2

/**
 * Saves the group dialog's values: the group on the server (name, description,
 * members, colour, keep-together) and its Auto-sort placement in this browser.
 * Reloads the store; returns the saved group.
 */
export async function saveGroupValues(values: ModGroupDialogValues, editing: ModGroup | null, store: ModGroupsStore): Promise<ModGroup | null> {
  const { placement, ...rest } = values
  const payload = {
    name: rest.name,
    description: rest.description,
    modIds: rest.modIds,
    color: rest.color,
    keepTogether: rest.keepTogether,
  }
  const response = editing ? await modsApi.updateGroup(editing.id, payload) : await modsApi.createGroup(payload)
  const id = response?.group?.id ?? editing?.id
  if (id) store.setPlacement(id, placement)
  await store.reload()
  return response?.group ?? null
}

/** Adds mods at the end of a group's order (those it already lists keep their place). */
export async function addModsToGroup(group: ModGroup, modIds: readonly string[], store: ModGroupsStore): Promise<string[]> {
  const present = new Set(group.modIds)
  const added = [...new Set(modIds)].filter((id) => !present.has(id))
  if (added.length > 0) {
    await modsApi.updateGroup(group.id, { modIds: [...group.modIds, ...added] })
    await store.reload()
  }
  return added
}

/** Whether taking `modIds` out would leave the group with too few members to keep. */
export function removalLeavesTooFew(group: ModGroup, modIds: readonly string[]): boolean {
  const removing = new Set(modIds)
  return group.modIds.filter((id) => !removing.has(id)).length < MIN_MEMBERS
}

export async function removeModsFromGroup(group: ModGroup, modIds: readonly string[], store: ModGroupsStore): Promise<void> {
  const removing = new Set(modIds)
  await modsApi.updateGroup(group.id, { modIds: group.modIds.filter((id) => !removing.has(id)) })
  await store.reload()
}
