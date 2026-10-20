import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle, Loader2, Sparkles, Undo2 } from 'lucide-react'
import { modsApi, type LoadOrderPlan } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { reportClientWarning } from '@/lib/client-errors'
import type { VariantModInfo } from '@/lib/modVariants'
import type { ConflictScanResult } from '@/types'
import { useConfirm } from '@/contexts/ConfirmContext'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { ConfidenceMark } from './ConfidenceMark'
import { useSuggestionReasonText } from './conflictSuggestions'
import { useHealthText } from './healthText'
import {
  buildAutofixPreview,
  candidateRules,
  defaultChecked,
  openConflictCount,
  removedMods,
  runAutofix,
  runOrder,
  type AutofixItem,
  type AutofixPreview,
  type AutofixReviewEntry,
} from './autofix'

export interface FixEverythingDeps {
  canManage: boolean
  /** Non-null: the button is disabled with this reason (e.g. an unsaved load order). */
  blockedReason: string | null
  conflicts: ConflictScanResult | null
  conflictsLoading: boolean
  conflictsStale: boolean
  conflictsError: string | null
  scanConflicts: () => void
  groups: ReadonlyArray<{ wsId: string; mods: ReadonlyArray<VariantModInfo & { enabled?: boolean }> }>
  isPairIgnored: (a: string, b: string) => boolean
  modName: (modId: string) => string | undefined
  itemTitle: (workshopId: string) => string | undefined
  /** After a run or its Undo wrote: the page reloads its config, rules and health. */
  onChanged: () => Promise<void> | void
}

type Phase = 'closed' | 'scanning' | 'preparing' | 'preview' | 'running' | 'done' | 'failed' | 'undoing' | 'undone' | 'error'

interface LastRun { snapshotId: string; addedRuleIds: string[] }

const REVIEW_SHOWN = 8

/**
 * "Fix everything": gathers the safe health fixes, the suggested winners as
 * pinned rules and the smart sort plan (removals and unsure pairs listed for
 * review), shows them in one dialog with the end result, applies the
 * checked ones in order and keeps an Undo for the whole run.
 */
export function useFixEverything(deps: FixEverythingDeps) {
  const { t } = useTranslation('modRules')
  const { t: tHealth } = useTranslation('modHealth')
  const { toast } = useToast()
  const confirm = useConfirm()
  const text = useHealthText({ modName: deps.modName, itemTitle: deps.itemTitle })
  const reasonText = useSuggestionReasonText()
  const [phase, setPhase] = useState<Phase>('closed')
  const [preview, setPreview] = useState<AutofixPreview | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<LoadOrderPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  const [outcome, setOutcome] = useState<{ applied: number; skipped: number; moved: number; failedLabel?: string; message?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<LastRun | null>(null)
  const sawScanRef = useRef(false)
  const depsRef = useRef(deps)
  useEffect(() => { depsRef.current = deps })

  const mod = text.mod
  const itemLabel = useCallback((item: AutofixItem): string => {
    switch (item.type) {
      case 'healthFix': return text.fixLabel(item.fix)
      case 'disableVariant': return t('autofix.variant', { mod: mod(item.modId) })
      case 'rule': return t('autofix.rule', { winner: item.sides.winnerName, loser: item.sides.loserName })
      default: return t('autofix.planItem')
    }
  }, [text, t, mod])

  const prepare = useCallback(async () => {
    setPhase('preparing')
    setError(null)
    try {
      const [health, rules] = await Promise.all([modsApi.getModHealth(), modsApi.getOrderRules()])
      const d = depsRef.current
      const next = buildAutofixPreview({
        health: health && Array.isArray(health.issues) ? health : null,
        pairs: d.conflicts?.pairs ?? [],
        rules: rules?.rules ?? [],
        groups: d.groups,
        isPairIgnored: d.isPairIgnored,
      })
      setPreview(next)
      setChecked(defaultChecked(next))
      setPlan(null)
      setPhase('preview')
    } catch (err) {
      reportClientWarning('Fix everything could not gather the fixes.', err)
      setError(getUserErrorMessage(err, t('autofix.loadFailedFallback')))
      setPhase('error')
    }
  }, [t])

  const openDialog = useCallback(() => {
    const d = depsRef.current
    setOutcome(null)
    setProgress(null)
    if (!d.conflicts || d.conflictsStale) {
      sawScanRef.current = d.conflictsLoading
      setPhase('scanning')
      if (!d.conflictsLoading) d.scanConflicts()
      return
    }
    void prepare()
  }, [prepare])

  // A rescan asked for by openDialog: go on once it has run and ended.
  useEffect(() => {
    if (phase !== 'scanning') return
    if (deps.conflictsLoading) {
      sawScanRef.current = true
      return
    }
    if (!sawScanRef.current) return
    if (deps.conflicts && !deps.conflictsStale) void prepare()
    else {
      setError(deps.conflictsError ?? t('autofix.loadFailedFallback'))
      setPhase('error')
    }
  }, [phase, deps.conflictsLoading, deps.conflicts, deps.conflictsStale, deps.conflictsError, prepare, t])

  // The plan with the checked rules, again whenever they change.
  const rulesKey = useMemo(() => (preview ? JSON.stringify(candidateRules(preview, checked)) : ''), [preview, checked])
  useEffect(() => {
    if (phase !== 'preview' || !preview) return
    let alive = true
    setPlanning(true)
    const timer = setTimeout(() => {
      modsApi.planLoadOrder({ rules: JSON.parse(rulesKey) as [string, string][] })
        .then((next) => { if (alive) setPlan(next) })
        .catch((err) => { if (alive) { reportClientWarning('Fix everything could not plan the load order.', err); setPlan(null) } })
        .finally(() => { if (alive) setPlanning(false) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [phase, preview, rulesKey])

  const pairs = useMemo(() => deps.conflicts?.pairs ?? [], [deps.conflicts])
  const result = useMemo(() => {
    if (!preview) return null
    const planOn = checked.has(preview.plan.id) && !!plan
    return {
      before: openConflictCount(pairs),
      after: openConflictCount(pairs, { order: planOn ? plan!.order : null, removed: removedMods(preview, checked) }),
      moves: planOn ? plan!.moves.length : 0,
    }
  }, [preview, checked, plan, pairs])

  const undo = useCallback(async (run: LastRun) => {
    setPhase((p) => (p === 'closed' ? p : 'undoing'))
    try {
      await modsApi.autofixRestore(run.snapshotId)
      for (const id of run.addedRuleIds) {
        try { await modsApi.deleteOrderRule(id) } catch (err) { reportClientWarning('Fix everything undo: a rule was already gone.', err) }
      }
      setLastRun(null)
      await depsRef.current.onChanged()
      depsRef.current.scanConflicts()
      setPhase((p) => (p === 'closed' ? p : 'undone'))
      toast({ title: t('autofix.undoneTitle'), description: t('autofix.undoneDesc') })
    } catch (err) {
      setPhase((p) => (p === 'closed' ? p : 'failed'))
      toast({ title: t('autofix.undoFailed', { message: getUserErrorMessage(err, t('autofix.loadFailedFallback')) }), variant: 'destructive' })
    }
  }, [t, toast])

  const apply = useCallback(async () => {
    if (!preview) return
    const items = runOrder(preview, checked)
    if (items.length === 0) return
    const removals = items.filter((item) => item.type === 'disableVariant' || (item.type === 'healthFix' && item.destructive))
    if (removals.length > 0) {
      const ok = await confirm({
        title: tHealth('confirm.title'),
        description: t('autofix.confirmRemovals'),
        items: removals.map(itemLabel),
        confirmLabel: tHealth('confirm.remove'),
        destructive: true,
      })
      if (!ok) return
    }
    setPhase('running')
    setProgress({ current: 0, total: items.length, label: t('autofix.snapshotStep') })
    const run = await runAutofix(items, {
      snapshot: () => modsApi.autofixSnapshot(),
      applyHealthFix: (issue, fix) => modsApi.applyModHealthFix(issue.id, fix.action, fix.params),
      disableMod: (modId) => modsApi.toggleModId(modId, false),
      addRule: (rule) => modsApi.addOrderRule({ ...rule, source: 'conflictResolve' }),
      plan: () => modsApi.planLoadOrder({}),
      saveOrder: (order) => modsApi.saveModOrder(order),
    }, (index, item) => setProgress({ current: index + 1, total: items.length, label: itemLabel(item) }))
    const kept = run.snapshotId ? { snapshotId: run.snapshotId, addedRuleIds: run.addedRuleIds } : null
    setLastRun(kept)
    if (run.snapshotId) {
      try { await depsRef.current.onChanged() } catch (err) { reportClientWarning('Fix everything: reloading the page data failed.', err) }
      depsRef.current.scanConflicts()
    }
    const failedLabel = run.failed ? (run.failed.item ? itemLabel(run.failed.item) : t('autofix.snapshotStep')) : undefined
    const message = run.failed ? getUserErrorMessage(run.failed.error, t('autofix.loadFailedFallback')) : undefined
    setOutcome({ applied: run.applied, skipped: run.skipped, moved: run.moved, failedLabel, message })
    setProgress(null)
    setPhase(run.failed ? 'failed' : 'done')
    const undoAction = kept ? (
      <ToastAction altText={t('autofix.undo')} onClick={() => void undo(kept)}>{t('autofix.undo')}</ToastAction>
    ) : undefined
    toast(run.failed
      ? { title: t('autofix.failedTitle', { label: failedLabel }), description: message, variant: 'destructive', action: undoAction }
      : { title: t('autofix.doneTitle'), description: t('autofix.doneDesc', { applied: run.applied, skipped: run.skipped, moved: run.moved }), action: undoAction })
  }, [preview, checked, confirm, t, tHealth, itemLabel, toast, undo])

  const close = useCallback(() => {
    setPhase((p) => (p === 'running' || p === 'undoing' ? p : 'closed'))
  }, [])

  const toggle = (id: string, on: boolean) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })
  const toggleAll = (items: AutofixItem[], on: boolean) => setChecked((prev) => {
    const next = new Set(prev)
    for (const item of items) {
      if (on) next.add(item.id)
      else next.delete(item.id)
    }
    return next
  })

  const itemReason = (item: AutofixItem): ReactNode => {
    switch (item.type) {
      case 'healthFix': return text.body(item.issue)[0] ?? text.title(item.issue)
      case 'disableVariant': return t('autofix.variantReason', { others: item.variantOf.map(mod).join(', ') })
      case 'rule': return reasonText(item.sides)
      default:
        if (planning && !plan) return t('autofix.planning')
        return plan && plan.moves.length > 0 ? t('autofix.planReasonMoves', { count: plan.moves.length }) : t('autofix.planReasonNone')
    }
  }

  const row = (item: AutofixItem) => {
    const id = `autofix-${item.id}`
    return (
      <li key={item.id} className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
        <Checkbox id={id} className="mt-0.5" checked={checked.has(item.id)} onCheckedChange={(v) => toggle(item.id, v === true)} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground" dir="auto">
            <span className="min-w-0 break-words">{itemLabel(item)}</span>
            {item.type === 'rule' && <ConfidenceMark confidence={item.sides.suggestion.confidence} />}
          </label>
          <p className="break-words text-xs text-muted-foreground" dir="auto">{itemReason(item)}</p>
        </div>
      </li>
    )
  }

  const section = (key: string, title: string, hint: string, items: AutofixItem[]) => {
    if (items.length === 0) return null
    const selected = items.filter((item) => checked.has(item.id)).length
    const all = selected === items.length
    return (
      <section aria-labelledby={`autofix-${key}`} className="space-y-2">
        <div className="flex items-start gap-3">
          <Checkbox
            className="mt-0.5"
            checked={all ? true : selected > 0 ? 'indeterminate' : false}
            onCheckedChange={(v) => toggleAll(items, v === true)}
            aria-label={t('autofix.selectAll', { section: title })}
          />
          <div className="min-w-0 flex-1">
            <h3 id={`autofix-${key}`} className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
              {title}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">{t('autofix.count', { selected, total: items.length })}</span>
            </h3>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        <ul className="space-y-2">{items.map(row)}</ul>
      </section>
    )
  }

  const reviewRow = (entry: AutofixReviewEntry) => (
    <li key={entry.key} className="rounded-lg border border-border/60 bg-muted/25 p-3">
      <p className="break-words text-sm font-medium text-foreground" dir="auto">
        {t('autofix.reviewPair', { a: entry.pair.modA.modName || entry.pair.modA.modId, b: entry.pair.modB.modName || entry.pair.modB.modId })}
      </p>
      <p className="break-words text-xs text-muted-foreground" dir="auto">
        {entry.sides ? t('autofix.reviewLow', { reason: reasonText(entry.sides) }) : t('autofix.reviewNoSuggestion')}
      </p>
    </li>
  )

  const selectedCount = preview ? runOrder(preview, checked).length : 0
  const nothing = !!preview && preview.fixes.length + preview.rules.length + preview.removals.length + preview.review.length === 0 && !(plan && plan.moves.length > 0)
  const open = phase !== 'closed'

  const dialog = open ? (
    <Dialog open onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('autofix.title')}</DialogTitle>
          <DialogDescription>{t('autofix.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {(phase === 'scanning' || phase === 'preparing') && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {phase === 'scanning' ? t('autofix.scanning') : t('autofix.preparing')}
            </p>
          )}
          {phase === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <span className="min-w-0 break-words text-foreground">{t('autofix.loadFailed', { message: error })}</span>
            </div>
          )}
          {phase === 'preview' && preview && result && (
            nothing ? (
              <p className="flex items-center gap-2 text-sm text-foreground">
                <CheckCircle className="h-4 w-4 text-success" aria-hidden="true" />
                {t('autofix.nothing')}
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-border/60 bg-muted/40 p-3" aria-live="polite">
                  <p className="text-sm font-medium tabular-nums text-foreground">{t('autofix.result', { before: result.before, after: result.after })}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {planning ? t('autofix.planning') : t('autofix.resultMoves', { count: result.moves })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('autofix.settledHint')}</p>
                </div>
                {section('fixes', t('autofix.sectionFixes'), t('autofix.sectionFixesHint'), preview.fixes)}
                {section('rules', t('autofix.sectionRules'), t('autofix.sectionRulesHint'), preview.rules)}
                {section('plan', t('autofix.sectionPlan'), t('autofix.sectionPlanHint'), [preview.plan])}
                {section('removals', t('autofix.sectionRemovals'), t('autofix.sectionRemovalsHint'), preview.removals)}
                {preview.review.length > 0 && (
                  <section aria-labelledby="autofix-review" className="space-y-2">
                    <div>
                      <h3 id="autofix-review" className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
                        {t('autofix.sectionReview')}
                        <span className="text-xs font-normal tabular-nums text-muted-foreground">{preview.review.length}</span>
                      </h3>
                      <p className="text-xs text-muted-foreground">{t('autofix.sectionReviewHint')}</p>
                    </div>
                    <ul className="space-y-2">{preview.review.slice(0, REVIEW_SHOWN).map(reviewRow)}</ul>
                    {preview.review.length > REVIEW_SHOWN && (
                      <p className="text-xs text-muted-foreground">{t('autofix.reviewMore', { count: preview.review.length - REVIEW_SHOWN })}</p>
                    )}
                  </section>
                )}
              </>
            )
          )}
          {phase === 'running' && progress && (
            <div className="space-y-2" aria-live="polite">
              <p className="break-words text-sm text-foreground">{t('autofix.running', progress)}</p>
              <Progress value={progress.total ? (progress.current / progress.total) * 100 : 0} aria-label={t('autofix.title')} />
            </div>
          )}
          {phase === 'undoing' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('autofix.undoing')}
            </p>
          )}
          {(phase === 'done' || phase === 'undone') && outcome && (
            <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 p-3 text-sm" role="status">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-foreground">{phase === 'undone' ? t('autofix.undoneTitle') : t('autofix.doneTitle')}</p>
                <p className="text-xs text-muted-foreground">
                  {phase === 'undone' ? t('autofix.undoneDesc') : t('autofix.doneDesc', { applied: outcome.applied, skipped: outcome.skipped, moved: outcome.moved })}
                </p>
              </div>
            </div>
          )}
          {phase === 'failed' && outcome && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <p className="break-words font-medium text-foreground">{t('autofix.failedTitle', { label: outcome.failedLabel })}</p>
                <p className="break-words text-xs text-muted-foreground">{t('autofix.failedDesc', { message: outcome.message, applied: outcome.applied })}</p>
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {phase === 'preview' && !nothing ? (
            <>
              <Button variant="outline" onClick={close}>{t('dialog.cancel')}</Button>
              <Button variant="command" onClick={() => void apply()} disabled={selectedCount === 0 || planning}>
                <Sparkles aria-hidden="true" />
                {t('autofix.apply', { count: selectedCount })}
              </Button>
            </>
          ) : (
            <>
              {(phase === 'done' || phase === 'failed') && lastRun && (
                <Button variant="outline" onClick={() => void undo(lastRun)}>
                  <Undo2 aria-hidden="true" />
                  {t('autofix.undo')}
                </Button>
              )}
              <Button variant="outline" onClick={close} disabled={phase === 'running' || phase === 'undoing'}>{t('autofix.close')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  const busy = phase === 'running' || phase === 'undoing' || phase === 'scanning' || phase === 'preparing'
  return { openDialog, busy, dialog }
}
