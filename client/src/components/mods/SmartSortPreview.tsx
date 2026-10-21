import { useCallback, useMemo } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Loader2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { LoadOrderPlanMove, ModGroup, SteamKnowledgeStatus } from '@/lib/api'
import { ConfidenceMark } from './ConfidenceMark'
import { GroupDot } from './GroupDots'
import { SteamStatusLine } from './SteamStatusLine'
import { useSmartText } from './smartText'
import type { SmartSortPreviewState } from './useLoadOrderPlan'

const SHOWN_PROBLEMS = 8

export interface SmartSortPreviewProps {
  state: SmartSortPreviewState
  /** A re-plan (mode switch, Steam refresh) is in flight. */
  busy: boolean
  modNames: ReadonlyMap<string, string>
  groupsById: ReadonlyMap<string, ModGroup>
  membership: ReadonlyMap<string, readonly ModGroup[]>
  tiered: boolean
  onTieredChange: (tiered: boolean) => void
  steamStatus?: SteamKnowledgeStatus | null
  onRefreshSteam?: () => void
  steamRefreshing?: boolean
  onApply: () => void
  onCancel: () => void
}

/**
 * What smart sort proposes before anything changes: each move with where it
 * goes and every reason, grouped by mod group, what could not be met and why,
 * the mods the game loads on its own, and the Steam data it used. Apply puts
 * the order on screen (Save Order still writes it); nothing to do reads as a
 * calm "Already in a good order".
 */
export function SmartSortPreview({
  state,
  busy,
  modNames,
  groupsById,
  membership,
  tiered,
  onTieredChange,
  steamStatus,
  onRefreshSteam,
  steamRefreshing,
  onApply,
  onCancel,
}: SmartSortPreviewProps) {
  const name = useCallback((modId: string) => modNames.get(modId) ?? modId, [modNames])
  const groupName = useCallback((groupId: string, fallback?: string) => groupsById.get(groupId)?.name || fallback || groupId, [groupsById])
  const text = useSmartText(name, groupName)
  const { t } = text
  const { plan } = state

  const sections = useMemo(() => {
    const byGroup = new Map<string, LoadOrderPlanMove[]>()
    const other: LoadOrderPlanMove[] = []
    for (const move of plan.moves) {
      const reasonGroup = move.reasons.find((r) => r.params?.group !== undefined && groupsById.has(r.params.group))?.params.group
      const groupId = reasonGroup ?? membership.get(move.modId)?.[0]?.id
      if (groupId && groupsById.has(groupId)) {
        const list = byGroup.get(groupId)
        if (list) list.push(move)
        else byGroup.set(groupId, [move])
      } else other.push(move)
    }
    const order = [...groupsById.keys()]
    return { groups: [...byGroup.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)), other }
  }, [plan.moves, membership, groupsById])

  const problems = [
    ...plan.cycles.map(text.cycleText),
    ...plan.unsatisfied.filter((u) => u.why !== 'missingMod').map(text.unsatisfiedText),
    ...plan.warnings.map(text.warningText).filter(Boolean),
    ...plan.winnersChanged.map(text.winnerChangedText),
  ]
  const missing = plan.unsatisfied.filter((u) => u.why === 'missingMod' && !u.loadedImplicitly).map(text.unsatisfiedText)
  const notes = [...plan.implicit.map(text.implicitText), ...missing]
  const changed = plan.changed && plan.moves.length > 0

  const renderMove = (move: LoadOrderPlanMove) => (
    <li key={move.modId} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
      <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
        <span className="sr-only">{t('sort.moveAria', { from: move.from + 1, to: move.to + 1 })}</span>
        <span className="w-8 text-end" aria-hidden="true">#{move.from + 1}</span>
        <ArrowRight className="h-3 w-3 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
        <span className="w-8 text-foreground" aria-hidden="true">#{move.to + 1}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate font-medium text-foreground">{name(move.modId)}</span>
        {modNames.has(move.modId) && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{move.modId}</span>}
        <ConfidenceMark confidence={move.confidence} className="ms-auto" />
      </span>
      <ul className="col-start-2 space-y-0.5 text-muted-foreground">
        {move.reasons.map((reason, i) => (
          <li key={i}>{text.reasonText(reason)}</li>
        ))}
      </ul>
    </li>
  )

  return (
    <section aria-labelledby="smart-sort-title" aria-busy={busy} className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id="smart-sort-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {changed ? <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />}
            {changed ? t('sort.title', { count: plan.moves.length }) : t('sort.calmTitle')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {changed ? t('sort.applyHint') : t('sort.calmDesc')} {t('sort.stats', { count: plan.satisfied, ms: Math.round(plan.stats.ms) })}
          </p>
        </div>
        <div className="flex gap-2">
          {changed ? (
            <>
              <Button variant="ghost" size="sm" onClick={onCancel}>{t('sort.cancel')}</Button>
              <Button variant="command" size="sm" onClick={onApply} disabled={busy}>{t('sort.apply')}</Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={onCancel}>{t('sort.close')}</Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
        <div className="min-w-0">
          <p id="smart-sort-tiered" className="text-sm font-medium text-foreground">{t('sort.tiered')}</p>
          <p className="text-xs text-muted-foreground">{t('sort.tieredHint')}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t('sort.busy')} />}
          <Switch checked={tiered} onCheckedChange={onTieredChange} disabled={busy} aria-labelledby="smart-sort-tiered" />
        </span>
      </div>

      <SteamStatusLine status={steamStatus ?? plan.steamStatus} onRefresh={onRefreshSteam} refreshing={steamRefreshing} />

      {problems.length > 0 && (
        <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3" role="status">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('sort.problemsTitle', { count: problems.length })}
          </p>
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-foreground">
            {problems.slice(0, SHOWN_PROBLEMS).map((problem, i) => <li key={i}>{problem}</li>)}
          </ul>
          {problems.length > SHOWN_PROBLEMS && (
            <p className="text-xs text-muted-foreground">{t('sort.moreProblems', { count: problems.length - SHOWN_PROBLEMS })}</p>
          )}
        </div>
      )}

      {notes.length > 0 && (
        <div className="space-y-1 rounded-lg border border-border/60 bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Info className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            {t('sort.notesTitle')}
          </p>
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">
            {notes.slice(0, SHOWN_PROBLEMS).map((note, i) => <li key={i}>{note}</li>)}
          </ul>
          {notes.length > SHOWN_PROBLEMS && <p className="text-xs text-muted-foreground">{t('sort.moreProblems', { count: notes.length - SHOWN_PROBLEMS })}</p>}
        </div>
      )}

      {changed && (
        <div className="max-h-80 overflow-y-auto rounded-lg border border-border/60 bg-card">
          {sections.groups.map(([groupId, moves]) => {
            const group = groupsById.get(groupId)
            return (
              <div key={groupId}>
                <p className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/50 bg-card px-3 py-1.5 text-xs font-medium text-foreground">
                  <GroupDot color={group?.color} />
                  {group?.name ?? groupId}
                  <span className="font-normal text-muted-foreground">{t('sort.groupMoves', { count: moves.length })}</span>
                </p>
                <ul className="divide-y divide-border/40">{moves.map(renderMove)}</ul>
              </div>
            )
          })}
          {sections.other.length > 0 && (
            <div>
              {sections.groups.length > 0 && (
                <p className="sticky top-0 z-10 border-b border-border/50 bg-card px-3 py-1.5 text-xs font-medium text-foreground">{t('sort.otherMods')}</p>
              )}
              <ul className="divide-y divide-border/40">{sections.other.map(renderMove)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
