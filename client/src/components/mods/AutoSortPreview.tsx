import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ModGroup } from '@/lib/api'
import { hasSortIssues, type AutoSortMove, type AutoSortReason, type AutoSortResult } from '@/lib/loadOrderAutoSort'
import { GroupDot } from './GroupDots'

export interface AutoSortPreviewProps {
  result: AutoSortResult
  modNames: ReadonlyMap<string, string>
  groupsById: ReadonlyMap<string, ModGroup>
  membership: ReadonlyMap<string, readonly ModGroup[]>
  onApply: () => void
  onCancel: () => void
}

/**
 * The proposal Auto-sort makes before anything changes: every moved mod with
 * where it goes and why, grouped by its mod group, what could not be met and
 * why, then Apply (an unsaved change, like a drag) or Cancel.
 */
export function AutoSortPreview({ result, modNames, groupsById, membership, onApply, onCancel }: AutoSortPreviewProps) {
  const { t } = useTranslation('mods')
  const label = (modId: string) => modNames.get(modId) ?? modId
  const groupName = (id: string) => groupsById.get(id)?.name ?? id

  const sections = useMemo(() => {
    const byGroup = new Map<string, AutoSortMove[]>()
    const other: AutoSortMove[] = []
    for (const move of result.moves) {
      // Under the group the move is about (a reason naming one), else its first group.
      const reasonGroup = move.reasons.find((r): r is Extract<AutoSortReason, { groupId: string }> => 'groupId' in r)?.groupId
      const groupId = reasonGroup ?? membership.get(move.modId)?.[0]?.id
      if (groupId && groupsById.has(groupId)) {
        const list = byGroup.get(groupId)
        if (list) list.push(move)
        else byGroup.set(groupId, [move])
      } else other.push(move)
    }
    const ordered = [...byGroup.entries()].sort(([a], [b]) => [...groupsById.keys()].indexOf(a) - [...groupsById.keys()].indexOf(b))
    return { groups: ordered, other }
  }, [result.moves, membership, groupsById])

  const reasonText = (reason: AutoSortReason): string => {
    switch (reason.kind) {
      case 'requires':
        return t('autoSort.reason.requires', { mod: label(reason.modId) })
      case 'requiredBy':
        return t('autoSort.reason.requiredBy', { mod: label(reason.modId) })
      case 'groupOrder':
        return t('autoSort.reason.groupOrder', { group: groupName(reason.groupId) })
      case 'together':
        return t('autoSort.reason.together', { group: groupName(reason.groupId) })
      case 'placement':
        return reason.placement === 'first'
          ? t('autoSort.reason.placementFirst', { group: groupName(reason.groupId) })
          : t('autoSort.reason.placementLast', { group: groupName(reason.groupId) })
      case 'winner':
        return t('autoSort.reason.winner', { mod: label(reason.over) })
      case 'keepsWinner':
        return t('autoSort.reason.keepsWinner', { mod: label(reason.winner) })
    }
  }

  const c = result.constraints
  const rules = [
    { key: 'dependencies', value: c.dependencies },
    { key: 'groupOrder', value: c.groupOrder },
    { key: 'together', value: c.together },
    { key: 'placement', value: c.placement },
    { key: 'winners', value: c.winners },
  ].filter((rule) => rule.value > 0)

  const renderMove = (move: AutoSortMove) => (
    <li key={move.modId} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs">
      <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
        <span className="w-7 text-end">#{move.from}</span>
        <ArrowRight className="h-3 w-3 shrink-0 rtl:-scale-x-100" aria-label={t('autoSort.movesTo')} />
        <span className="w-7 text-foreground">#{move.to}</span>
      </span>
      <span className="min-w-0">
        <span className="font-mono text-foreground">{move.modId}</span>
        {modNames.get(move.modId) && <span className="ms-2 text-muted-foreground">{modNames.get(move.modId)}</span>}
      </span>
      {move.reasons.length > 0 && (
        <span className="col-start-2 text-muted-foreground">{move.reasons.slice(0, 3).map(reasonText).join(' · ')}</span>
      )}
    </li>
  )

  const issues: string[] = [
    ...result.cycles.map((cycle) => t('loadOrder.circularDependency', { mods: cycle.join(', ') })),
    ...result.groupOrderConflicts.map((conflict) =>
      conflict.cause === 'dependency'
        ? t('autoSort.issue.groupVsDependency', { group: groupName(conflict.groupId), before: conflict.before, after: conflict.after })
        : t('autoSort.issue.groupVsGroup', { group: groupName(conflict.groupId), before: conflict.before, after: conflict.after }),
    ),
    ...result.splitGroups.map((split) =>
      t('autoSort.issue.split', { groups: split.groupIds.map(groupName).join(', '), mods: split.between.join(', ') }),
    ),
    ...result.placementConflicts.map((conflict) =>
      t('autoSort.issue.placement', { mods: conflict.modIds.join(', '), groups: conflict.groupIds.map(groupName).join(', ') }),
    ),
    ...result.winnersChanged.map((change) =>
      t(`autoSort.issue.winner.${change.cause}`, { newWinner: label(change.newWinner), previousWinner: label(change.previousWinner) }),
    ),
  ]

  return (
    <section aria-labelledby="auto-sort-preview-title" className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id="auto-sort-preview-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" />
            {t('loadOrder.proposedOrder', { count: result.moves.length })}
          </h3>
          {rules.length > 0 && (
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {rules.map((rule) => (
                <span key={rule.key}>
                  {t(`autoSort.rules.${rule.key}`)} <span className="tabular-nums text-foreground">{rule.value}</span>
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('loadOrder.cancel')}</Button>
          <Button variant="command" size="sm" onClick={onApply}>{t('loadOrder.apply')}</Button>
        </div>
      </div>

      {hasSortIssues(result) && (
        <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3" role="status">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('autoSort.issuesTitle', { count: issues.length })}
          </p>
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-foreground">
            {issues.slice(0, 8).map((issue, i) => <li key={i}>{issue}</li>)}
          </ul>
          {issues.length > 8 && <p className="text-xs text-muted-foreground">{t('autoSort.moreIssues', { count: issues.length - 8 })}</p>}
        </div>
      )}

      {result.moves.length > 0 && (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border/60 bg-card">
          {sections.groups.map(([groupId, moves]) => {
            const group = groupsById.get(groupId)
            return (
              <div key={groupId}>
                <p className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/50 bg-card px-3 py-1.5 text-xs font-medium text-foreground">
                  <GroupDot color={group?.color} />
                  {group?.name ?? groupId}
                  <span className="font-normal text-muted-foreground">{t('autoSort.groupMoves', { count: moves.length })}</span>
                </p>
                <ul className="divide-y divide-border/40">{moves.map(renderMove)}</ul>
              </div>
            )
          })}
          {sections.other.length > 0 && (
            <div>
              {sections.groups.length > 0 && (
                <p className="sticky top-0 z-10 border-b border-border/50 bg-card px-3 py-1.5 text-xs font-medium text-foreground">
                  {t('autoSort.otherMods')}
                </p>
              )}
              <ul className="divide-y divide-border/40">{sections.other.map(renderMove)}</ul>
            </div>
          )}
        </div>
      )}

      {result.missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('loadOrder.missingRequirements', { count: result.missing.length })}
        </p>
      )}
    </section>
  )
}
