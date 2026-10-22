// "Fix everything": one run over what the panel already knows. Pure parts
// (what to offer, the end result) and the run itself, which goes through
// the existing routes in this order: snapshot (for Undo), health fixes and
// removals, pinned rules for the suggested winners, the smart sort plan
// saved through POST /mods/save-order. The page rescans afterwards.

import { ApiError, type LoadOrderPlan, type ModHealth, type ModHealthFix, type ModHealthFixResult, type ModHealthIssue, type ModOrderRule } from '@/lib/api'
import { computeVariantSiblings, type VariantModInfo } from '@/lib/modVariants'
import type { ConflictPair } from '@/types'
import { suggestionSides, type SuggestionSides } from './conflictSuggestions'
import { isDestructiveFix, isSafeFix } from './healthText'
import { findOppositeRule, findSameRule } from './useOrderRules'

export type AutofixItem =
  | { id: string; type: 'healthFix'; destructive: boolean; issue: ModHealthIssue; fix: ModHealthFix }
  | { id: string; type: 'disableVariant'; modId: string; variantOf: string[] }
  | { id: string; type: 'rule'; sides: SuggestionSides }
  | { id: string; type: 'plan' }

export interface AutofixReviewEntry {
  key: string
  pair: ConflictPair
  /** A low-confidence suggestion, or null when nothing points either way. */
  sides: SuggestionSides | null
}

export interface AutofixPreview {
  fixes: AutofixItem[]
  rules: AutofixItem[]
  plan: AutofixItem
  removals: AutofixItem[]
  review: AutofixReviewEntry[]
}

export interface AutofixInput {
  health: ModHealth | null
  pairs: readonly ConflictPair[]
  rules: readonly ModOrderRule[]
  /** The Active items with their mods (enabled, require=, loadModAfter=...). */
  groups: ReadonlyArray<{ wsId: string; mods: ReadonlyArray<VariantModInfo & { enabled?: boolean }> }>
  isPairIgnored: (a: string, b: string) => boolean
}

/** A pair with a high or medium severity file: what the Conflicts view calls higher-impact. */
export function isHigherImpact(pair: ConflictPair): boolean {
  return pair.highCount > 0 || pair.mediumCount > 0
}

const sure = (sides: SuggestionSides | null): sides is SuggestionSides => !!sides && sides.suggestion.confidence !== 'low'

/** What "Fix everything" offers, grouped; the items checked by default are `defaultChecked`. */
export function buildAutofixPreview({ health, pairs, rules, groups, isPairIgnored }: AutofixInput): AutofixPreview {
  const fixes: AutofixItem[] = []
  const removals: AutofixItem[] = []
  const removing = new Set<string>()
  for (const issue of health?.issues ?? []) {
    // The order problems are the plan's job (it also follows the new rules).
    const safe = issue.fixes.find((fix) => isSafeFix(fix) && fix.action !== 'applyPlan')
    if (safe) {
      fixes.push({ id: `fix:${issue.id}:${safe.action}`, type: 'healthFix', destructive: false, issue, fix: safe })
      continue
    }
    issue.fixes.filter(isDestructiveFix).forEach((fix, i) => {
      removals.push({ id: `fix:${issue.id}:${fix.action}:${i}`, type: 'healthFix', destructive: true, issue, fix })
      if (fix.action === 'removeMods') for (const id of fix.params.modIds ?? []) removing.add(id)
    })
  }

  // True variants of one Workshop item that are both enabled: disabling one
  // is the operator's call (never checked), unless a health fix offers it already.
  const enabled = new Set(groups.flatMap((g) => g.mods.filter((m) => m.enabled !== false).map((m) => m.id)))
  const variants = computeVariantSiblings(pairs, groups, isPairIgnored)
  for (const byMod of variants.values()) {
    for (const [modId, siblings] of byMod) {
      const others = [...siblings].filter((s) => enabled.has(s)).sort()
      if (!enabled.has(modId) || others.length === 0 || removing.has(modId)) continue
      removals.push({ id: `variant:${modId}`, type: 'disableVariant', modId, variantOf: others })
    }
  }

  const ruleItems: AutofixItem[] = []
  const review: AutofixReviewEntry[] = []
  const seen = new Set<string>()
  for (const pair of pairs) {
    const sides = suggestionSides(pair)
    if (sure(sides)) {
      if (sides.suggestion.alreadyWinning) continue
      if (findSameRule(rules, sides.loser, sides.winner) || findOppositeRule(rules, sides.loser, sides.winner)) continue
      const key = `${sides.loser}\u0000${sides.winner}`
      if (seen.has(key)) continue
      seen.add(key)
      ruleItems.push({ id: `rule:${sides.loser}>${sides.winner}`, type: 'rule', sides })
    } else if (isHigherImpact(pair)) {
      review.push({ key: `${pair.modA.modId}--${pair.modB.modId}`, pair, sides })
    }
  }
  return { fixes, rules: ruleItems, plan: { id: 'plan', type: 'plan' }, removals, review }
}

/** Checked when the dialog opens: the safe fixes, the rules and the plan; never a removal. */
export function defaultChecked(preview: AutofixPreview): Set<string> {
  return new Set([...preview.fixes, ...preview.rules, preview.plan].map((item) => item.id))
}

/** The [before, after] rules the checked suggestions add (the plan preview uses them). */
export function candidateRules(preview: AutofixPreview, checked: ReadonlySet<string>): [string, string][] {
  const out: [string, string][] = []
  for (const item of preview.rules) {
    if (item.type === 'rule' && checked.has(item.id)) out.push([item.sides.loser, item.sides.winner])
  }
  return out
}

/** The mods the checked removals take out of Mods=. */
export function removedMods(preview: AutofixPreview, checked: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const item of preview.removals) {
    if (!checked.has(item.id)) continue
    if (item.type === 'disableVariant') out.add(item.modId)
    else if (item.type === 'healthFix' && item.fix.action === 'removeMods') for (const id of item.fix.params.modIds ?? []) out.add(id)
  }
  return out
}

/**
 * Higher-impact conflicts still open: neither settled by a sure suggestion
 * (its winner loads after the other mod in `order`; without a position the
 * scan's alreadyWinning answers) nor gone (one of its mods in `removed`).
 */
export function openConflictCount(pairs: readonly ConflictPair[], { order = null, removed = new Set<string>() }: { order?: readonly string[] | null; removed?: ReadonlySet<string> } = {}): number {
  const pos = new Map((order ?? []).map((id, i) => [id, i]))
  let open = 0
  for (const pair of pairs) {
    if (!isHigherImpact(pair)) continue
    if (removed.has(pair.modA.modId) || removed.has(pair.modB.modId)) continue
    const sides = suggestionSides(pair)
    if (sure(sides)) {
      const w = pos.get(sides.winner)
      const l = pos.get(sides.loser)
      const wins = w !== undefined && l !== undefined ? w > l : sides.suggestion.alreadyWinning
      if (wins) continue
    }
    open++
  }
  return open
}

// ─── The run ──────────────────────────────────────────────────────────────

export interface AutofixApi {
  snapshot: () => Promise<{ snapshotId: string }>
  applyHealthFix: (issue: ModHealthIssue, fix: ModHealthFix) => Promise<ModHealthFixResult>
  disableMod: (modId: string) => Promise<unknown>
  addRule: (rule: { before: string; after: string }) => Promise<{ rule: ModOrderRule; existing: boolean }>
  plan: () => Promise<LoadOrderPlan>
  saveOrder: (order: string[]) => Promise<unknown>
}

export interface AutofixRunResult {
  snapshotId: string | null
  applied: number
  /** Solved by an earlier step, or changed since the preview. */
  skipped: number
  moved: number
  addedRuleIds: string[]
  failed: { item: AutofixItem | null; error: unknown } | null
}

/** The order the run takes: fixes, removals, rules, then the plan. */
export function runOrder(preview: AutofixPreview, checked: ReadonlySet<string>): AutofixItem[] {
  return [...preview.fixes, ...preview.removals, ...preview.rules, preview.plan].filter((item) => checked.has(item.id))
}

const SKIPPABLE = new Set(['MODS_HEALTH_ISSUE_GONE', 'MODS_HEALTH_FIX_NOT_OFFERED'])

/**
 * Runs `items` (runOrder()) one by one; stops at the first error. The
 * snapshot comes first so Undo can put the mod list back whatever happens.
 */
export async function runAutofix(
  items: readonly AutofixItem[],
  api: AutofixApi,
  onStep: (index: number, item: AutofixItem) => void,
): Promise<AutofixRunResult> {
  const result: AutofixRunResult = { snapshotId: null, applied: 0, skipped: 0, moved: 0, addedRuleIds: [], failed: null }
  try {
    result.snapshotId = (await api.snapshot()).snapshotId
  } catch (error) {
    result.failed = { item: null, error }
    return result
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    onStep(i, item)
    try {
      if (item.type === 'healthFix') {
        const outcome = await api.applyHealthFix(item.issue, item.fix)
        if (outcome.applied) result.applied++
        else result.skipped++
      } else if (item.type === 'disableVariant') {
        await api.disableMod(item.modId)
        result.applied++
      } else if (item.type === 'rule') {
        const added = await api.addRule({ before: item.sides.loser, after: item.sides.winner })
        if (!added.existing) result.addedRuleIds.push(added.rule.id)
        result.applied++
      } else {
        const plan = await api.plan()
        if (plan.changed) {
          await api.saveOrder(plan.order)
          result.moved = plan.moves.length
        }
        result.applied++
      }
    } catch (error) {
      if (item.type === 'healthFix' && error instanceof ApiError && error.code && SKIPPABLE.has(error.code)) {
        result.skipped++
        continue
      }
      result.failed = { item, error }
      return result
    }
  }
  return result
}
