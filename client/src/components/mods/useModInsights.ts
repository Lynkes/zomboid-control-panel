import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { modsApi, type ModInsight, type ModInsights } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'

/** While Steam data is still being fetched in the background, read again this often, a few times. */
export const INSIGHTS_PENDING_POLL_MS = 20_000
const MAX_PENDING_POLLS = 3

export interface ModInsightsStore {
  insights: ModInsights | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  refreshing: boolean
  /** Fetches the Steam data again now (refresh=1), then answers with it. */
  refreshSteam: () => Promise<void>
  reload: () => Promise<void>
  insightOf: (modId: string) => ModInsight | undefined
  /** Workshop item to the items its Steam page lists as required. */
  requirementsOf: (workshopId: string) => ModInsights['workshopRequirements'][number]['requires']
}

const NO_REQUIREMENTS: ModInsights['workshopRequirements'][number]['requires'] = []

/**
 * What the panel makes of each enabled mod (kind, dependents, Steam "Required
 * items"): one request for the whole list, read again when the saved Mods=
 * line changes (`refreshKey`). No per-row requests.
 */
export function useModInsights({ enabled, refreshKey = '' }: { enabled: boolean; refreshKey?: string }): ModInsightsStore {
  const [insights, setInsights] = useState<ModInsights | null>(null)
  const [loadState, setLoadState] = useState<ModInsightsStore['loadState']>('idle')
  const [refreshing, setRefreshing] = useState(false)
  const seq = useRef(0)
  const polls = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (refresh: boolean) => {
    const id = ++seq.current
    if (!refresh) setLoadState((state) => (state === 'ready' ? state : 'loading'))
    try {
      const data = await modsApi.getModInsights(refresh)
      if (!alive.current || id !== seq.current) return
      setInsights(data && typeof data === 'object' && data.mods ? data : null)
      setLoadState('ready')
    } catch (error) {
      if (!alive.current || id !== seq.current) return
      // Kinds and Steam requirements are an aid: the lists work without them.
      reportClientWarning('Failed to load mod insights.', error)
      setLoadState((state) => (state === 'ready' ? state : 'error'))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    polls.current = 0
    void load(false)
  }, [enabled, refreshKey, load])

  // Steam data still arriving in the background: read again a few times.
  const pending = insights?.steamStatus?.pending === true
  useEffect(() => {
    if (!enabled || !pending || polls.current >= MAX_PENDING_POLLS) return
    const timer = setTimeout(() => {
      polls.current += 1
      void load(false)
    }, INSIGHTS_PENDING_POLL_MS)
    return () => clearTimeout(timer)
  }, [enabled, pending, insights, load])

  const refreshSteam = useCallback(async () => {
    setRefreshing(true)
    try {
      await load(true)
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [load])

  const reload = useCallback(() => load(false), [load])

  const requirements = useMemo(() => new Map((insights?.workshopRequirements ?? []).map((entry) => [entry.workshopId, entry.requires])), [insights])
  // Own keys only: a mod ID such as "constructor" must not read Object.prototype.
  const insightOf = useCallback(
    (modId: string) => (insights?.mods && Object.prototype.hasOwnProperty.call(insights.mods, modId) ? insights.mods[modId] : undefined),
    [insights],
  )
  const requirementsOf = useCallback((workshopId: string) => requirements.get(workshopId) ?? NO_REQUIREMENTS, [requirements])

  return { insights, loadState, refreshing, refreshSteam, reload, insightOf, requirementsOf }
}
