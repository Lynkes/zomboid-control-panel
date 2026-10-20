import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Lightbulb, Loader2, Pin, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { DisabledReason } from '@/components/DisabledReason'
import type { ConflictPair } from '@/types'
import { ConfidenceMark } from './ConfidenceMark'
import { OrderRuleErrorNotice } from './OrderRuleErrorNotice'
import type { OrderRuleErrorExplanation } from './orderRuleErrors'
import { findSameRule } from './useOrderRules'
import { suggestionSides, usePinSuggestion, useSuggestionReasonText, type ConflictsSmart } from './conflictSuggestions'

export type { ConflictsSmart } from './conflictSuggestions'

/** Small marker in a collapsed conflict pair: who the panel suggests, or that it already wins. */
export function ConflictSuggestionChip({ pair }: { pair: ConflictPair }) {
  const { t } = useTranslation('modRules')
  const sides = suggestionSides(pair)
  if (!sides) return null
  if (sides.suggestion.alreadyWinning) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-foreground"
        title={t('suggestion.chipAsSuggestedTitle', { winner: sides.winnerName })}
      >
        <CheckCircle className="h-3 w-3 text-success" aria-hidden="true" />
        {t('suggestion.chipAsSuggested')}
      </span>
    )
  }
  return (
    <span
      className="inline-flex min-w-0 max-w-[14rem] shrink items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-foreground"
      title={t('suggestion.chipSuggestTitle', { winner: sides.winnerName })}
    >
      <Lightbulb className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
      <span className="truncate" dir="auto">{t('suggestion.chipSuggest', { winner: sides.winnerName })}</span>
    </span>
  )
}

/**
 * Inside an open conflict pair: "Suggested: X should load last and win", how
 * sure, why, and one click to pin it (a rule: the loser always loads before
 * the winner), then "Sort now".
 */
export function ConflictSuggestion({ pair, smart }: { pair: ConflictPair; smart: ConflictsSmart }) {
  const { t } = useTranslation('modRules')
  const { toast } = useToast()
  const reasonText = useSuggestionReasonText()
  const pin = usePinSuggestion(smart)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<OrderRuleErrorExplanation | null>(null)
  const sides = suggestionSides(pair)
  if (!sides) return null
  const { suggestion } = sides
  const pinned = !!findSameRule(smart.rules.rules, sides.loser, sides.winner)

  const sortNowAction = (
    <ToastAction altText={t('suggestion.sortNow')} onClick={smart.onSortNow}>
      {t('suggestion.sortNow')}
    </ToastAction>
  )

  const apply = async () => {
    if (!smart.canManage || busy) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await pin(sides)
      if (outcome.error) {
        setError(outcome.error)
        return
      }
      if (!outcome.stored) return
      toast({
        title: t('suggestion.appliedTitle'),
        description: t('suggestion.appliedDesc', { winner: sides.winnerName, loser: sides.loserName }),
        action: sortNowAction,
      })
      smart.onRuleAdded()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-muted/40 p-3" data-conflict-suggestion="">
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
          <span className="min-w-0 break-words" dir="auto">{t('suggestion.suggested', { winner: sides.winnerName })}</span>
          <ConfidenceMark confidence={suggestion.confidence} showLabel />
        </p>
        <p className="break-words text-xs text-muted-foreground" dir="auto">{reasonText(sides)}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {suggestion.alreadyWinning ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-foreground">
            <CheckCircle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            {t('suggestion.alreadyWinner')}
          </span>
        ) : pinned ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Pin className="h-3.5 w-3.5" aria-hidden="true" />
              {t('suggestion.pinnedNotSorted')}
            </span>
            <Button variant="outline" size="sm" onClick={smart.onSortNow}>
              <Wand2 aria-hidden="true" />
              {t('suggestion.sortNow')}
            </Button>
          </>
        ) : (
          <DisabledReason reason={!smart.canManage ? t('suggestion.noPermission') : null}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void apply()}
              disabled={!smart.canManage || busy}
              aria-label={t('suggestion.applyAria', { winner: sides.winnerName, loser: sides.loserName })}
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {t('suggestion.apply')}
            </Button>
          </DisabledReason>
        )}
      </div>
      {error && <OrderRuleErrorNotice explanation={error} className="w-full" />}
    </div>
  )
}
