import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle, Loader2, Sparkles, Undo2 } from 'lucide-react'
import { modsApi, serversApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useHealthText } from '@/components/mods/healthText'
import { runFixAll, undoFixAll, hasUndo, type FixAllItem, type FixAllPreview, type FixAllUndo } from './problemFixes'
import { useProblemText } from './useProblemText'

type Phase = 'preview' | 'running' | 'done' | 'failed' | 'undoing' | 'undone'

const noName = () => undefined

/**
 * "Fix all safe issues": one preview (each fix checked, with its reason in
 * plain words), the run with its progress, stopping at the first error, and
 * one Undo for everything the run changed.
 */
export function FixAllDialog({
  preview,
  onClose,
  onChanged,
}: {
  preview: FixAllPreview
  onClose: () => void
  /** After the run or its Undo wrote something: the page scans again. */
  onChanged: (appliedIds: string[]) => void
}) {
  const { t } = useTranslation('problems')
  const text = useProblemText()
  const health = useHealthText({ modName: noName, itemTitle: noName })
  const [checked, setChecked] = useState<Set<string>>(() => new Set(preview.items.map((item) => item.id)))
  const [phase, setPhase] = useState<Phase>('preview')
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  const [outcome, setOutcome] = useState<{ applied: number; skipped: number; failedLabel?: string; message?: string } | null>(null)
  const [undo, setUndo] = useState<FixAllUndo | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)

  const label = useCallback((item: FixAllItem): string => (
    item.type === 'healthFix'
      ? health.fixLabel(item.fix)
      : t('fix.raiseMemory', { current: item.currentGb, next: item.nextGb })
  ), [health, t])

  const reason = (item: FixAllItem): string => (
    item.type === 'raiseMemory'
      ? t('fixAll.memoryReason', { title: text.title(item.finding) })
      : t('fixAll.reason', { title: text.title(item.finding) })
  )

  const selected = preview.items.filter((item) => checked.has(item.id))

  const apply = async () => {
    if (selected.length === 0) return
    setPhase('running')
    setProgress({ current: 0, total: selected.length, label: '' })
    const run = await runFixAll(selected, {
      snapshot: () => modsApi.autofixSnapshot(),
      applyHealthFix: (issue, fix) => modsApi.applyModHealthFix(issue.id, fix.action, fix.params),
      setMaxMemory: (serverId, gb) => serversApi.update(serverId, { maxMemory: gb }),
    }, (index, item) => setProgress({
      current: Math.max(0, index) + 1,
      total: selected.length,
      label: item ? label(item) : t('fixAll.snapshotStep'),
    }))
    setUndo(hasUndo(run.undo) ? run.undo : null)
    const failedAt = run.failed ? (run.failed.item ? selected.indexOf(run.failed.item) : 0) : selected.length
    onChanged(selected.slice(0, failedAt).map((item) => item.finding.id))
    setOutcome({
      applied: run.applied,
      skipped: run.skipped,
      failedLabel: run.failed ? (run.failed.item ? label(run.failed.item) : t('fixAll.snapshotStep')) : undefined,
      message: run.failed ? getUserErrorMessage(run.failed.error, t('fixAll.failedFallback')) : undefined,
    })
    setProgress(null)
    setPhase(run.failed ? 'failed' : 'done')
  }

  const runUndo = async () => {
    if (!undo) return
    setPhase('undoing')
    setUndoError(null)
    try {
      await undoFixAll(undo, {
        restore: (snapshotId) => modsApi.autofixRestore(snapshotId),
        setMaxMemory: (serverId, gb) => serversApi.update(serverId, { maxMemory: gb }),
      })
      setUndo(null)
      onChanged([])
      setPhase('undone')
    } catch (err) {
      setUndoError(getUserErrorMessage(err, t('fixAll.failedFallback')))
      setPhase('failed')
    }
  }

  const toggle = (id: string, on: boolean) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })

  const busy = phase === 'running' || phase === 'undoing'
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('fixAll.title')}</DialogTitle>
          <DialogDescription>{t('fixAll.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {phase === 'preview' && (
            preview.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('fixAll.nothing')}</p>
            ) : (
              <ul className="space-y-2">
                {preview.items.map((item) => {
                  const id = `fix-all-${item.id}`
                  return (
                    <li key={item.id} className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
                      <Checkbox id={id} className="mt-0.5" checked={checked.has(item.id)} onCheckedChange={(v) => toggle(item.id, v === true)} />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <label htmlFor={id} className="block break-words text-sm font-medium text-foreground" dir="auto">{label(item)}</label>
                        <p className="break-words text-xs text-muted-foreground" dir="auto">{reason(item)}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          )}
          {phase === 'preview' && preview.needsDecision > 0 && (
            <p className="text-xs text-muted-foreground">{t('fixAll.needsDecision', { n: preview.needsDecision })}</p>
          )}
          {phase === 'running' && progress && (
            <div className="space-y-2" aria-live="polite">
              <p className="break-words text-sm text-foreground">{t('fixAll.running', progress)}</p>
              <Progress value={progress.total ? (progress.current / progress.total) * 100 : 0} aria-label={t('fixAll.title')} />
            </div>
          )}
          {phase === 'undoing' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('fixAll.undoing')}
            </p>
          )}
          {(phase === 'done' || phase === 'undone') && outcome && (
            <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 p-3 text-sm" role="status">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-foreground">{phase === 'undone' ? t('fixAll.undoneTitle') : t('fixAll.doneTitle')}</p>
                <p className="text-xs text-muted-foreground">
                  {phase === 'undone' ? t('fixAll.undoneDesc') : t('fixAll.doneDesc', { applied: outcome.applied, skipped: outcome.skipped })}
                </p>
              </div>
            </div>
          )}
          {phase === 'failed' && (outcome || undoError) && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                {undoError ? (
                  <p className="break-words font-medium text-foreground">{t('fixAll.undoFailed', { message: undoError })}</p>
                ) : outcome && (
                  <>
                    <p className="break-words font-medium text-foreground">{t('fixAll.failedTitle', { label: outcome.failedLabel })}</p>
                    <p className="break-words text-xs text-muted-foreground">{t('fixAll.failedDesc', { message: outcome.message, applied: outcome.applied })}</p>
                  </>
                )}
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {phase === 'preview' && preview.items.length > 0 ? (
            <>
              <Button variant="outline" onClick={onClose}>{t('fixAll.cancel')}</Button>
              <Button variant="command" onClick={() => void apply()} disabled={selected.length === 0}>
                <Sparkles aria-hidden="true" />
                {t('fixAll.apply', { n: selected.length })}
              </Button>
            </>
          ) : (
            <>
              {(phase === 'done' || phase === 'failed') && undo && (
                <Button variant="outline" onClick={() => void runUndo()}>
                  <Undo2 aria-hidden="true" />
                  {t('undo')}
                </Button>
              )}
              <Button variant="outline" onClick={onClose} disabled={busy}>{t('fixAll.close')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
