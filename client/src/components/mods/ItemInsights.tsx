import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import type { ModHealth, ModHealthFix, ModHealthIssue, ModInsight, ModInsights } from '@/lib/api'
import { cn } from '@/lib/utils'
import { KindChip } from './KindChip'
import { missingRequirementFix } from './smartText'

type Requirement = ModInsights['workshopRequirements'][number]['requires'][number]

export interface ItemInsightsProps {
  modIds: readonly string[]
  insightOf: (modId: string) => ModInsight | undefined
  /** The Workshop items this item's Steam page lists as required. */
  requires: readonly Requirement[]
  health: ModHealth | null
  canManage: boolean
  /** Applies the health check's own fix (adds the item and the mods it needs). */
  onApplyFix: (issue: ModHealthIssue, fix: ModHealthFix) => Promise<void>
  /** No health fix for it: opens the Add mod dialog on that item. */
  onAddItem: (workshopId: string) => void
}

/**
 * The inspector's smart part for one Workshop item: each loaded mod's kind
 * (and how many mods need it), and the item's Steam "Required items" with
 * whether each is on the server and enabled, and a one-click add when not.
 */
export function ItemInsights({ modIds, insightOf, requires, health, canManage, onApplyFix, onAddItem }: ItemInsightsProps) {
  const { t } = useTranslation('modsSmart')
  const [adding, setAdding] = useState<string | null>(null)
  const kinds = modIds.map((id) => ({ id, insight: insightOf(id) })).filter((entry) => entry.insight)

  if (kinds.length === 0 && requires.length === 0) return null

  const add = async (requirement: Requirement) => {
    const found = missingRequirementFix(health, requirement.workshopId)
    if (!found) {
      onAddItem(requirement.workshopId)
      return
    }
    setAdding(requirement.workshopId)
    try {
      await onApplyFix(found.issue, found.fix)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      {kinds.length > 0 && (
        <div className="space-y-1.5">
          <p className="label-micro">{t('item.kindsTitle')}</p>
          <ul className="space-y-1">
            {kinds.map(({ id, insight }) => (
              <li key={id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="min-w-0 truncate font-mono text-muted-foreground">{id}</span>
                <KindChip insight={insight} />
                {insight && insight.dependents > 0 && <span className="text-muted-foreground">{t('neededBy', { count: insight.dependents })}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {requires.length > 0 && (
        <div className="space-y-1.5">
          <p className="label-micro">{t('item.requiredTitle')}</p>
          <ul className="space-y-1.5">
            {requires.map((requirement) => {
              const state = requirement.enabled ? 'enabled' : requirement.installed ? 'installed' : 'missing'
              return (
                <li key={requirement.workshopId} className="flex items-center gap-2 text-xs">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', state === 'enabled' ? 'bg-success' : state === 'installed' ? 'bg-warning' : 'bg-destructive')} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{requirement.title || requirement.workshopId}</span>
                    <span className="text-muted-foreground">{t(`item.state.${state}`)}</span>
                  </span>
                  {state === 'missing' && (
                    <DisabledReason reason={!canManage ? t('item.noPermission') : null}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canManage || adding !== null}
                        onClick={() => void add(requirement)}
                        aria-label={t('item.addAria', { item: requirement.title || requirement.workshopId })}
                      >
                        {adding === requirement.workshopId ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                        {missingRequirementFix(health, requirement.workshopId) ? t('item.add') : t('item.addOpen')}
                      </Button>
                    </DisabledReason>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
