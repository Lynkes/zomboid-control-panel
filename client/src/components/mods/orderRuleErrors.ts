import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ApiError } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

/** One step of a refused rule's loop (server/utils/modOrderRules.js findOrderRuleCycle). */
export interface OrderRuleCycleEdge {
  before: string
  after: string
  reason: 'new' | 'rule' | 'require' | string
  ruleId?: string
}

export interface OrderRuleErrorExplanation {
  kind: 'cycle' | 'limit' | 'other'
  /** One sentence: what went wrong. */
  title: string
  /** For a loop: each link of it in plain words, starting with the new rule. */
  steps: string[]
  /** For a loop: the mod IDs around it (first and last are the same mod). */
  cycle: string[]
}

function payloadOf(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null
  const data = error.data
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.code) return error.code
  const code = payloadOf(error)?.code
  return typeof code === 'string' ? code : undefined
}

/** The loop a 409 MODS_ORDER_RULE_CYCLE answer carries, or null. */
export function cycleDetailsOf(error: unknown): { cycle: string[]; edges: OrderRuleCycleEdge[] } | null {
  if (codeOf(error) !== 'MODS_ORDER_RULE_CYCLE') return null
  const details = payloadOf(error)?.details
  if (!details || typeof details !== 'object') return null
  const { cycle, edges } = details as { cycle?: unknown; edges?: unknown }
  const ids = Array.isArray(cycle) ? cycle.filter((id): id is string => typeof id === 'string') : []
  const steps = Array.isArray(edges)
    ? edges.filter((edge): edge is OrderRuleCycleEdge =>
        !!edge && typeof edge === 'object' && typeof (edge as OrderRuleCycleEdge).before === 'string' && typeof (edge as OrderRuleCycleEdge).after === 'string')
    : []
  return { cycle: ids, edges: steps }
}

/**
 * A failed "add order rule" in plain words. A loop names every link of it
 * ("Brita requires TchernoLib", "a pinned rule keeps X after Y"), the cap
 * names the cap; anything else is the translated server error.
 */
export function explainOrderRuleError(
  error: unknown,
  t: TFunction,
  name: (modId: string) => string,
  fallbackMax?: number,
): OrderRuleErrorExplanation {
  const code = codeOf(error)
  if (code === 'MODS_ORDER_RULE_CYCLE') {
    const details = cycleDetailsOf(error)
    const cycle = details?.cycle ?? []
    const steps = (details?.edges ?? []).map((edge) => {
      const params = { before: name(edge.before), after: name(edge.after) }
      if (edge.reason === 'new') return t('errors.stepNew', params)
      if (edge.reason === 'rule') return t('errors.stepRule', params)
      if (edge.reason === 'require') return t('errors.stepRequire', params)
      return t('errors.stepOther', params)
    })
    const mods = cycle.length > 1 ? cycle.slice(0, -1) : cycle
    return {
      kind: 'cycle',
      title: mods.length > 0
        ? t('errors.cycleTitle', { count: mods.length, mods: [...mods, mods[0]].map(name).join(' → ') })
        : t('errors.cycleTitleUnknown'),
      steps,
      cycle,
    }
  }
  if (code === 'MODS_ORDER_RULE_LIMIT') {
    const params = payloadOf(error)?.params as { max?: unknown } | undefined
    const max = typeof params?.max === 'number' ? params.max : fallbackMax
    return { kind: 'limit', title: max ? t('errors.limit', { max }) : t('errors.limitUnknown'), steps: [], cycle: [] }
  }
  return { kind: 'other', title: getUserErrorMessage(error, t('errors.addFailed')), steps: [], cycle: [] }
}

/** explainOrderRuleError bound to the modRules namespace and a name lookup. */
export function useOrderRuleErrorText(modNames: ReadonlyMap<string, string>, fallbackMax?: number) {
  const { t } = useTranslation('modRules')
  return useCallback(
    (error: unknown) => explainOrderRuleError(error, t, (id) => modNames.get(id) ?? id, fallbackMax),
    [t, modNames, fallbackMax],
  )
}
