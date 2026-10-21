import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { modsApi, type ModGroup, type ModGroupsStatus } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'
import { buildGroupMembership } from '@/lib/modGroupTools'
import { migrateLegacyPlacements, type GroupPlacement } from './groupPlacementMigration'

export interface ModGroupsStore {
  groups: ModGroup[]
  enforce: boolean
  loadState: 'loading' | 'ready' | 'error'
  /** Per-group in-order status against the saved Mods= list; null when unknown. */
  status: ModGroupsStatus | null
  /** Mod ID to the groups listing it. */
  membership: Map<string, ModGroup[]>
  groupsById: Map<string, ModGroup>
  /** Each placed group's smart-sort placement (the server's `placement`). */
  placements: Record<string, GroupPlacement>
  setEnforce: (enforce: boolean) => void
  /** Reads the groups and their status again. */
  reload: () => Promise<void>
  reloadStatus: () => Promise<void>
}

/**
 * The mod groups as the whole Mod Manager sees them: the list, the "keep group
 * order" switch and the in-order status (read again whenever the saved load
 * order changes). Placements come from the server; the first load also moves
 * the ones an older version kept in this browser to the server, once.
 * `enabled: false` makes it inert, for a panel that was handed the page's store.
 */
export function useModGroupsStore({ enabled = true, savedModIds }: { enabled?: boolean; savedModIds?: readonly string[] } = {}): ModGroupsStore {
  const [groups, setGroups] = useState<ModGroup[]>([])
  const [enforce, setEnforce] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [status, setStatus] = useState<ModGroupsStatus | null>(null)
  const aliveRef = useRef(true)
  const groupsSeq = useRef(0)
  const statusSeq = useRef(0)
  const migrationStarted = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const loadGroups = useCallback(async () => {
    const seq = ++groupsSeq.current
    try {
      const data = await modsApi.getGroups()
      if (!aliveRef.current || seq !== groupsSeq.current) return
      const list = Array.isArray(data?.groups) ? data.groups : []
      setGroups(list)
      setEnforce(data?.enforce === true)
      setLoadState('ready')
      if (!migrationStarted.current) {
        migrationStarted.current = true
        const { migrated } = await migrateLegacyPlacements(list)
        if (migrated.length > 0 && aliveRef.current) void loadGroups()
      }
    } catch (error) {
      if (!aliveRef.current || seq !== groupsSeq.current) return
      reportClientWarning('Failed to load mod groups.', error)
      setLoadState('error')
    }
  }, [])

  const reloadStatus = useCallback(async () => {
    const seq = ++statusSeq.current
    try {
      const data = await modsApi.getGroupsStatus()
      if (!aliveRef.current || seq !== statusSeq.current) return
      setStatus(data && Array.isArray(data.groups) ? data : null)
    } catch (error) {
      if (!aliveRef.current || seq !== statusSeq.current) return
      // The lists still work without the in-order badges.
      reportClientWarning('Failed to load the mod groups status.', error)
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    if (enabled) void loadGroups()
  }, [enabled, loadGroups])

  // Read again whenever the saved load order changes: a save, an Apply, a mod
  // added or removed on another tab, a switch of the active server.
  const savedOrderKey = useMemo(() => (savedModIds ? savedModIds.join('\n') : ''), [savedModIds])
  useEffect(() => {
    if (enabled) void reloadStatus()
  }, [enabled, reloadStatus, savedOrderKey])

  const reload = useCallback(async () => {
    await Promise.all([loadGroups(), reloadStatus()])
  }, [loadGroups, reloadStatus])

  const membership = useMemo(() => buildGroupMembership(groups), [groups])
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  const placements = useMemo(() => {
    const result: Record<string, GroupPlacement> = {}
    for (const group of groups) if (group.placement === 'first' || group.placement === 'last') result[group.id] = group.placement
    return result
  }, [groups])

  return { groups, enforce, loadState, status, membership, groupsById, placements, setEnforce, reload, reloadStatus }
}
