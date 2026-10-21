import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, ArrowUpToLine, Info } from 'lucide-react'
import type { ModGroup } from '@/lib/api'
import type { ConflictScanResult } from '@/types'
import type { RowActionItem } from '@/components/ui/row-actions'
import { useToast } from '@/components/ui/use-toast'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useModHealth } from './useModHealth'
import { useModInsights } from './useModInsights'
import { useOrderRules } from './useOrderRules'
import { planCacheKey, planConflictPairs, useCurrentPlan, useSmartSort } from './useLoadOrderPlan'

export interface SmartModsInput {
  canManage: boolean
  /** The active server's ini is readable (smart routes answer). */
  configured: boolean
  saved: { modIds?: readonly string[]; workshopIds?: readonly string[]; maps?: readonly string[] } | null
  /** The order on screen (unsaved changes included). */
  order: readonly string[]
  /** The Load order view is open: plan the order on screen for "Why is it here?". */
  planCurrent: boolean
  groups: readonly ModGroup[]
  conflicts: ConflictScanResult | null
  /** The cached scan no longer matches this server's config (or another server's). */
  conflictsStale: boolean
}

/**
 * Everything smart sort v2 adds to the Mod Manager, in one place: the
 * insights (kinds, Steam requirements), the health check, the order rules,
 * the plan of the order on screen, the smart sort proposal, and the open
 * "Why is it here?" and "Always load after…" pickers. One request each for
 * the whole list; the page only renders.
 */
export function useSmartMods({ canManage, configured, saved, order, planCurrent, groups, conflicts, conflictsStale }: SmartModsInput) {
  const { t } = useTranslation('modsSmart')
  const { toast } = useToast()
  const enabled = canManage && configured
  const savedKey = saved ? `${(saved.modIds ?? []).join(';')}|${(saved.workshopIds ?? []).join(';')}|${(saved.maps ?? []).join(';')}` : ''

  const insights = useModInsights({ enabled, refreshKey: savedKey })
  const health = useModHealth({ enabled, refreshKey: savedKey })
  const rules = useOrderRules({ enabled })

  const conflictPairs = useMemo(() => planConflictPairs(conflicts, conflictsStale), [conflicts, conflictsStale])
  const version = useMemo(() => {
    const groupsKey = groups.map((g) => `${g.id}:${g.keepTogether ? 1 : 0}:${g.placement ?? ''}:${g.modIds.join(',')}`).join('|')
    const rulesKey = rules.rules.map((r) => r.id).join(',')
    const pairsKey = planCacheKey(conflictPairs.map((p) => `${p[0]}>${p[1]}`), '')
    return planCacheKey([groupsKey, rulesKey, pairsKey, insights.insights?.steamStatus?.fetchedAt ?? ''], savedKey)
  }, [groups, rules.rules, conflictPairs, insights.insights?.steamStatus?.fetchedAt, savedKey])

  const current = useCurrentPlan({ order, enabled: enabled && planCurrent, version, conflictPairs })
  const movingIds = useMemo(() => new Set(current.fresh ? (current.plan?.moves ?? []).map((m) => m.modId) : []), [current.fresh, current.plan])

  const onSortError = useCallback(
    (error: unknown) => toast({ title: t('sort.failedTitle'), description: getUserErrorMessage(error, t('sort.failedFallback')), variant: 'destructive' }),
    [toast, t],
  )
  const smartSort = useSmartSort({ conflictPairs, onError: onSortError })

  // "Why is it here?" and the "Always load after/before…" picker.
  const [why, setWhy] = useState<{ modId: string; anchor: HTMLElement | null } | null>(null)
  const [pin, setPin] = useState<{ modId: string; direction: 'after' | 'before' } | null>(null)
  const explain = useCallback((modId: string, anchor: HTMLElement | null) => setWhy({ modId, anchor }), [])
  const closeWhy = useCallback(() => setWhy(null), [])
  const openPin = useCallback((modId: string, direction: 'after' | 'before') => {
    setWhy(null)
    setPin({ modId, direction })
  }, [])

  const rowMenu = useCallback(
    (modId: string): RowActionItem[] => [
      {
        label: t('why.menuItem'),
        icon: Info,
        onSelect: () => {
          const button = Array.from(document.querySelectorAll<HTMLElement>('[data-why-here]')).find((el) => el.dataset.whyHere === modId) ?? null
          explain(modId, button)
        },
      },
      {
        label: t('why.pinAfter'),
        icon: ArrowDownToLine,
        onSelect: () => openPin(modId, 'after'),
        disabled: !canManage,
        reason: !canManage ? t('item.noPermission') : undefined,
      },
      {
        label: t('why.pinBefore'),
        icon: ArrowUpToLine,
        onSelect: () => openPin(modId, 'before'),
        disabled: !canManage,
        reason: !canManage ? t('item.noPermission') : undefined,
      },
    ],
    [t, canManage, explain, openPin],
  )

  /** A rule, a group or a fix changed what plans depend on. */
  const invalidatePlans = current.invalidate

  return {
    insights,
    health,
    rules,
    current,
    movingIds,
    conflictPairs,
    smartSort,
    why,
    explain,
    closeWhy,
    pin,
    openPin,
    closePin: () => setPin(null),
    rowMenu,
    invalidatePlans,
  }
}

export type SmartMods = ReturnType<typeof useSmartMods>
