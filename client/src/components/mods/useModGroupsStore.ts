import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { modsApi, type ModGroup, type ModGroupsStatus } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'
import { buildGroupMembership } from '@/lib/modGroupTools'
import type { GroupPlacement } from '@/lib/loadOrderAutoSort'
import { readStored, writeStored } from '@/lib/safeStorage'

// Where a group sits in Auto-sort ("first" / "last"). The server keeps a
// group's name, colour, members and keep-together flag; it does not keep a
// placement, so this browser does (keyed by group id).
const PLACEMENT_KEY = 'zcp:mods:groupPlacement'

function readPlacements(): Record<string, GroupPlacement> {
  try {
    const parsed = JSON.parse(readStored(PLACEMENT_KEY) ?? '{}') as Record<string, unknown>
    const result: Record<string, GroupPlacement> = {}
    for (const [id, value] of Object.entries(parsed ?? {})) {
      if (value === 'first' || value === 'last') result[id] = value
    }
    return result
  } catch {
    return {}
  }
}

export interface ModGroupsStore {
  groups: ModGroup[]
  enforce: boolean
  loadState: 'loading' | 'ready' | 'error'
  /** Per-group in-order status against the saved Mods= list; null when unknown. */
  status: ModGroupsStatus | null
  /** Mod ID to the groups listing it. */
  membership: Map<string, ModGroup[]>
  groupsById: Map<string, ModGroup>
  placements: Record<string, GroupPlacement>
  setPlacement: (groupId: string, placement: GroupPlacement | null) => void
  setEnforce: (enforce: boolean) => void
  /** Reads the groups and their status again. */
  reload: () => Promise<void>
  reloadStatus: () => Promise<void>
}

/**
 * The mod groups as the whole Mod Manager sees them: the list, the "keep group
 * order" switch, the in-order status (read again whenever the saved load order
 * changes) and the per-browser placements. `enabled: false` makes it inert, for
 * a panel that was handed the page's store instead.
 */
export function useModGroupsStore({ enabled = true, savedModIds }: { enabled?: boolean; savedModIds?: readonly string[] } = {}): ModGroupsStore {
  const [groups, setGroups] = useState<ModGroup[]>([])
  const [enforce, setEnforce] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [status, setStatus] = useState<ModGroupsStatus | null>(null)
  const [placements, setPlacements] = useState<Record<string, GroupPlacement>>(readPlacements)
  const aliveRef = useRef(true)
  const groupsSeq = useRef(0)
  const statusSeq = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const loadGroups = useCallback(async () => {
    const seq = ++groupsSeq.current
    try {
      const data = await modsApi.getGroups()
      if (!aliveRef.current || seq !== groupsSeq.current) return
      setGroups(Array.isArray(data?.groups) ? data.groups : [])
      setEnforce(data?.enforce === true)
      setLoadState('ready')
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

  const setPlacement = useCallback((groupId: string, placement: GroupPlacement | null) => {
    setPlacements((previous) => {
      const next = { ...previous }
      if (placement) next[groupId] = placement
      else delete next[groupId]
      writeStored(PLACEMENT_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const membership = useMemo(() => buildGroupMembership(groups), [groups])
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])

  return { groups, enforce, loadState, status, membership, groupsById, placements, setPlacement, setEnforce, reload, reloadStatus }
}
