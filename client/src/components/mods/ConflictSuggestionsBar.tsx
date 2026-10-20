import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, Loader2, Pin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { DisabledReason } from '@/components/DisabledReason'
import { useConfirm } from '@/contexts/ConfirmContext'
import type { ConflictPair } from '@/types'
import { highConfidenceSuggestions, usePinSuggestion, type ConflictsSmart } from './conflictSuggestions'

/**
 * Above the conflict pairs: "Apply all high-confidence suggestions (N)".
 * One confirm lists every rule it will pin; they are stored one by one and
 * the run stops at the first refusal, saying which one and why.
 */
export function ConflictSuggestionsBar({ pairs, smart }: { pairs: readonly ConflictPair[]; smart: ConflictsSmart }) {
  const { t } = useTranslation('modRules')
  const { toast } = useToast()
  const confirm = useConfirm()
  const pin = usePinSuggestion(smart)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const candidates = useMemo(() => highConfidenceSuggestions(pairs, smart), [pairs, smart])

  if (candidates.length === 0 && !progress) return null

  const sortNowAction = (
    <ToastAction altText={t('suggestion.sortNow')} onClick={smart.onSortNow}>
      {t('suggestion.sortNow')}
    </ToastAction>
  )

  const applyAll = async () => {
    if (!smart.canManage || progress) return
    const list = candidates
    const ok = await confirm({
      title: t('bar.confirmTitle'),
      description: t('bar.confirmDesc'),
      items: list.map((sides) => t('bar.confirmItem', { winner: sides.winnerName, loser: sides.loserName })),
      confirmLabel: t('bar.confirmLabel', { count: list.length }),
      destructive: false,
    })
    if (!ok) return
    let done = 0
    setProgress({ done, total: list.length })
    try {
      for (const sides of list) {
        const outcome = await pin(sides, { ask: false })
        if (!outcome.stored) {
          toast({
            title: done > 0 ? t('bar.stoppedTitle', { count: done }) : t('suggestion.failedTitle'),
            description: t('bar.stoppedDesc', {
              winner: sides.winnerName,
              loser: sides.loserName,
              reason: outcome.error?.title ?? t('errors.addFailed'),
            }),
            variant: 'destructive',
          })
          if (done > 0) smart.onRuleAdded()
          return
        }
        done += 1
        setProgress({ done, total: list.length })
      }
      toast({ title: t('bar.doneTitle', { count: done }), description: t('bar.doneDesc'), action: sortNowAction })
      smart.onRuleAdded()
    } finally {
      setProgress(null)
    }
  }

  const count = candidates.length
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-muted/40 p-3" data-conflict-suggestions-bar="">
      <Lightbulb className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-foreground">{t('bar.text', { count })}</p>
      <DisabledReason reason={!smart.canManage ? t('bar.noPermission') : null}>
        <Button variant="outline" size="sm" onClick={() => void applyAll()} disabled={!smart.canManage || !!progress || count === 0}>
          {progress ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Pin aria-hidden="true" />}
          {progress ? t('bar.applying', { done: progress.done, total: progress.total }) : t('bar.applyAll', { count })}
        </Button>
      </DisabledReason>
    </div>
  )
}
