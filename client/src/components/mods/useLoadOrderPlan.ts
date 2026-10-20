import { useCallback, useEffect, useRef, useState } from 'react'
import { modsApi, type LoadOrderPlan, type SmartReason } from '@/lib/api'
import type { ConflictScanResult } from '@/types'
import { reportClientWarning } from '@/lib/client-errors'
import { useLocalStorageState } from '@/lib/modsShared'

/** Wait this long after the last change before planning the current order again. */
export const CURRENT_PLAN_DEBOUNCE_MS = 800
const CACHE_SIZE = 8

export type PlanMode = 'minimal' | 'tiered'

/** A short, stable key for an order plus whatever else the plan depends on. */
export function planCacheKey(order: readonly string[], version: string): string {
  const text = `${version}\u0001${order.join('\n')}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${order.length}:${(hash >>> 0).toString(36)}`
}

/**
 * The conflict pairs a plan should keep today's winners for: the cached
 * scan's pairs that are real conflicts (not intended overrides, not a
 * declared incompatibility), and none at all while that scan no longer
 * matches the server's config (stale, or made for another server).
 */
export function planConflictPairs(conflicts: Pick<ConflictScanResult, 'pairs'> | null | undefined, stale: boolean): [string, string][] {
  if (!conflicts || stale) return []
  const pairs: [string, string][] = []
  for (const pair of conflicts.pairs ?? []) {
    const a = pair.modA?.modId
    const b = pair.modB?.modId
    if (!a || !b || a === b) continue
    const real = (pair.files ?? []).some((file) => file.severity !== 'info' && file.intended !== true && file.kind !== 'declared-incompatible')
    if (real) pairs.push([a, b])
  }
  return pairs
}

/** A plan's reasons for one mod (own keys only: "constructor" is a mod ID too). */
export function explanationsOf(plan: LoadOrderPlan | null | undefined, modId: string): SmartReason[] {
  const explanations = plan?.explanations
  return explanations && Object.prototype.hasOwnProperty.call(explanations, modId) ? explanations[modId] ?? [] : []
}

export interface CurrentPlan {
  /** The latest plan received; `fresh` says whether it is for the order on screen. */
  plan: LoadOrderPlan | null
  fresh: boolean
  loading: boolean
  /** Forget the cached plans (a rule, a group or a fix changed what they depend on). */
  invalidate: () => void
}

/**
 * The plan for the order on screen, for "Why is it here?": planned again
 * ~800 ms after the last change, an older request cancelled, answers cached
 * by order (moving a mod and back costs nothing). Never blocks the list.
 */
export function useCurrentPlan({
  order,
  enabled,
  version,
  conflictPairs,
}: {
  order: readonly string[]
  enabled: boolean
  version: string
  conflictPairs: [string, string][]
}): CurrentPlan {
  const cache = useRef(new Map<string, LoadOrderPlan>())
  const [state, setState] = useState<{ key: string; plan: LoadOrderPlan } | null>(null)
  const [loading, setLoading] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const pairsRef = useRef(conflictPairs)
  pairsRef.current = conflictPairs
  const key = planCacheKey(order, `${version}\u0002${epoch}`)

  useEffect(() => {
    if (!enabled || order.length === 0) return
    const cached = cache.current.get(key)
    if (cached) {
      setState({ key, plan: cached })
      return
    }
    const snapshot = [...order]
    const timer = setTimeout(() => {
      controller.current?.abort()
      const abort = new AbortController()
      controller.current = abort
      setLoading(true)
      modsApi
        .planLoadOrder({ order: snapshot, mode: 'minimal', groups: true, conflictPairs: pairsRef.current }, { signal: abort.signal })
        .then((plan) => {
          if (abort.signal.aborted || !plan || !Array.isArray(plan.order)) return
          cache.current.set(key, plan)
          if (cache.current.size > CACHE_SIZE) cache.current.delete(cache.current.keys().next().value as string)
          setState({ key, plan })
        })
        .catch((error) => {
          if (!abort.signal.aborted) reportClientWarning('Failed to plan the current load order.', error)
        })
        .finally(() => {
          if (controller.current === abort) {
            controller.current = null
            setLoading(false)
          }
        })
    }, CURRENT_PLAN_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `order` is captured through `key` (its hash) on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key])

  useEffect(() => () => controller.current?.abort(), [])

  const invalidate = useCallback(() => {
    cache.current.clear()
    setEpoch((value) => value + 1)
  }, [])

  return { plan: state?.plan ?? null, fresh: state?.key === key, loading, invalidate }
}

export interface SmartSortPreviewState {
  plan: LoadOrderPlan
  mode: PlanMode
  /** The order the plan was made from (Apply replaces exactly this). */
  input: string[]
}

/**
 * Auto-sort through the server's planner: plans the order on screen
 * (unsaved changes included), keeps the proposal until Apply or Cancel, and
 * re-plans in the other mode or after a Steam refresh.
 */
export function useSmartSort({ conflictPairs, onError }: { conflictPairs: [string, string][]; onError: (error: unknown) => void }) {
  const [preview, setPreview] = useState<SmartSortPreviewState | null>(null)
  const [busy, setBusy] = useState(false)
  const [tiered, setTiered] = useLocalStorageState<boolean>('zcp:mods:order:tieredSort', false)
  const seq = useRef(0)

  const run = useCallback(
    async (order: readonly string[], mode: PlanMode) => {
      const id = ++seq.current
      setBusy(true)
      try {
        const plan = await modsApi.planLoadOrder({ order: [...order], mode, groups: true, conflictPairs })
        if (id !== seq.current) return null
        setPreview({ plan, mode, input: [...order] })
        return plan
      } catch (error) {
        if (id === seq.current) onError(error)
        return null
      } finally {
        if (id === seq.current) setBusy(false)
      }
    },
    [conflictPairs, onError],
  )

  const open = useCallback((order: readonly string[]) => run(order, tiered ? 'tiered' : 'minimal'), [run, tiered])

  const setMode = useCallback(
    (mode: PlanMode) => {
      setTiered(mode === 'tiered')
      if (preview) void run(preview.input, mode)
    },
    [preview, run, setTiered],
  )

  const replan = useCallback(() => (preview ? run(preview.input, preview.mode) : Promise.resolve(null)), [preview, run])

  const close = useCallback(() => {
    seq.current++
    setBusy(false)
    setPreview(null)
  }, [])

  return { preview, busy, tiered, open, setMode, replan, close }
}
