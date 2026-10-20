import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/contexts/ConfirmContext'
import type { ConflictWinnerSuggestion } from '@/lib/api'
import type { ConflictPair } from '@/types'
import { explainOrderRuleError, type OrderRuleErrorExplanation } from './orderRuleErrors'
import { findOppositeRule, findSameRule, type OrderRulesStore } from './useOrderRules'

/** What the Conflicts view needs for suggested winners (Mods.tsx passes it). */
export interface ConflictsSmart {
  rules: OrderRulesStore
  canManage: boolean
  /** After a rule was stored: the page re-reads the cached scan (its suggestions now say "rule") and re-plans. */
  onRuleAdded: () => void
  /** Opens the smart sort preview on the Load order view. */
  onSortNow: () => void
}

export interface SuggestionSides {
  suggestion: ConflictWinnerSuggestion
  winner: string
  loser: string
  winnerName: string
  loserName: string
}

/** The suggested winner and loser of a pair, with their names; null without a suggestion. */
export function suggestionSides(pair: ConflictPair): SuggestionSides | null {
  const suggestion = pair.suggestion
  if (!suggestion) return null
  const aWins = suggestion.winner === pair.modA.modId
  if (!aWins && suggestion.winner !== pair.modB.modId) return null
  const [win, lose] = aWins ? [pair.modA, pair.modB] : [pair.modB, pair.modA]
  return {
    suggestion,
    winner: win.modId,
    loser: lose.modId,
    winnerName: win.modName || win.modId,
    loserName: lose.modName || lose.modId,
  }
}

/**
 * The suggestions worth applying in bulk: high confidence, not winning yet,
 * no rule stored for the pair either way (an opposite rule is the operator's
 * own choice, never replaced in bulk), one per winner/loser pair.
 */
export function highConfidenceSuggestions(pairs: readonly ConflictPair[], smart: Pick<ConflictsSmart, 'rules'>): SuggestionSides[] {
  const seen = new Set<string>()
  const out: SuggestionSides[] = []
  for (const pair of pairs) {
    const sides = suggestionSides(pair)
    if (!sides || sides.suggestion.confidence !== 'high' || sides.suggestion.alreadyWinning) continue
    if (findSameRule(smart.rules.rules, sides.loser, sides.winner) || findOppositeRule(smart.rules.rules, sides.loser, sides.winner)) continue
    const key = `${sides.loser}\u0000${sides.winner}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(sides)
  }
  return out
}

/** The suggestion's reason in plain words. */
export function useSuggestionReasonText() {
  const { t } = useTranslation('modRules')
  return useCallback((sides: SuggestionSides) => {
    const { suggestion, winnerName: winner, loserName: loser } = sides
    const params = suggestion.params ?? {}
    if (suggestion.reason === 'smallOverride') {
      return t('suggestion.reason.smallOverride', {
        winner,
        loser,
        count: params.files ?? 0,
        conflicting: params.conflicting ?? 0,
        otherFiles: params.otherFiles ?? 0,
      })
    }
    return t(`suggestion.reason.${suggestion.reason}`, { winner, loser })
  }, [t])
}

/**
 * Stores "loser before winner" as a pinned rule (source conflictResolve),
 * asking first when a rule the other way round exists (unless `ask` is
 * false). Resolves with { stored } or the refusal explained (a loop, the
 * cap). Toasts nothing: callers word their own outcome.
 */
export function usePinSuggestion(smart: ConflictsSmart | undefined) {
  const { t } = useTranslation('modRules')
  const confirm = useConfirm()
  return useCallback(async (sides: SuggestionSides, { ask = true }: { ask?: boolean } = {}): Promise<{ stored: boolean; error: OrderRuleErrorExplanation | null }> => {
    if (!smart) return { stored: false, error: null }
    const names = new Map([[sides.winner, sides.winnerName], [sides.loser, sides.loserName]])
    const opposite = findOppositeRule(smart.rules.rules, sides.loser, sides.winner)
    if (opposite && ask) {
      const ok = await confirm({
        title: t('dialog.replaceTitle'),
        // The new rule is loser-before-winner; the stored one keeps the loser after the winner.
        description: t('dialog.replaceDesc', { before: sides.loserName, after: sides.winnerName }),
        confirmLabel: t('dialog.replaceConfirm'),
        variant: 'warning',
      })
      if (!ok) return { stored: false, error: null }
    }
    try {
      await smart.rules.add({
        before: sides.loser,
        after: sides.winner,
        source: 'conflictResolve',
        ...(opposite ? { replaceOpposite: true } : {}),
      })
      return { stored: true, error: null }
    } catch (error) {
      return { stored: false, error: explainOrderRuleError(error, t, (id) => names.get(id) ?? id, smart.rules.max) }
    }
  }, [smart, confirm, t])
}
