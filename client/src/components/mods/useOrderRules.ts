import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { modsApi, type ModOrderRule, type ModOrderRuleInput } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'

/** The server's cap (MOD_ORDER_RULE_LIMITS.maxRules) until GET answers its own. */
export const DEFAULT_MAX_ORDER_RULES = 2000

export interface OrderRulesStore {
  rules: ModOrderRule[]
  max: number
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  reload: () => Promise<void>
  /** POST /mods/order-rules; on success reloads `rules`; rejects with the ApiError (409 cycle/limit...). */
  add: (input: ModOrderRuleInput) => Promise<{ rule: ModOrderRule; existing: boolean; replaced: string[] }>
  remove: (id: string) => Promise<void>
  /** Rules naming this mod on either side (memoised index). */
  rulesFor: (modId: string) => ModOrderRule[]
}

const NONE: ModOrderRule[] = []

/**
 * The panel-wide order rules ("pinned order": X always loads after Y). Read
 * once when enabled; every add and delete reads them again, so the list
 * always shows what the server stored (an add can replace an opposite rule).
 */
export function useOrderRules({ enabled }: { enabled: boolean }): OrderRulesStore {
  const [rules, setRules] = useState<ModOrderRule[]>(NONE)
  const [max, setMax] = useState(DEFAULT_MAX_ORDER_RULES)
  const [loadState, setLoadState] = useState<OrderRulesStore['loadState']>('idle')
  const aliveRef = useRef(true)
  const seqRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const reload = useCallback(async () => {
    const seq = ++seqRef.current
    setLoadState((state) => (state === 'ready' ? state : 'loading'))
    try {
      const data = await modsApi.getOrderRules()
      if (!aliveRef.current || seq !== seqRef.current) return
      setRules(Array.isArray(data?.rules) ? data.rules : NONE)
      if (typeof data?.max === 'number' && data.max > 0) setMax(data.max)
      setLoadState('ready')
    } catch (error) {
      if (!aliveRef.current || seq !== seqRef.current) return
      reportClientWarning('Failed to load the mod order rules.', error)
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    if (enabled) void reload()
  }, [enabled, reload])

  const add = useCallback(async (input: ModOrderRuleInput) => {
    const result = await modsApi.addOrderRule(input)
    await reload()
    return result
  }, [reload])

  const remove = useCallback(async (id: string) => {
    await modsApi.deleteOrderRule(id)
    if (aliveRef.current) setRules((previous) => previous.filter((rule) => rule.id !== id))
    await reload()
  }, [reload])

  const index = useMemo(() => {
    const map = new Map<string, ModOrderRule[]>()
    for (const rule of rules) {
      for (const modId of rule.before === rule.after ? [rule.before] : [rule.before, rule.after]) {
        const list = map.get(modId)
        if (list) list.push(rule)
        else map.set(modId, [rule])
      }
    }
    return map
  }, [rules])

  const rulesFor = useCallback((modId: string) => index.get(modId) ?? NONE, [index])

  return useMemo(
    () => ({ rules, max, loadState, reload, add, remove, rulesFor }),
    [rules, max, loadState, reload, add, remove, rulesFor],
  )
}

/** The stored rule ordering the same two mods the other way round, if any. */
export function findOppositeRule(rules: readonly ModOrderRule[], before: string, after: string): ModOrderRule | undefined {
  return rules.find((rule) => rule.before === after && rule.after === before)
}

/** The stored rule that already says exactly this, if any. */
export function findSameRule(rules: readonly ModOrderRule[], before: string, after: string): ModOrderRule | undefined {
  return rules.find((rule) => rule.before === before && rule.after === after)
}
