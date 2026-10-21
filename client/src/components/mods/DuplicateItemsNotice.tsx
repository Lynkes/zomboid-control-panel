import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { ApiError, type ModHealthFix, type ModHealthFixResult, type ModHealthIssue } from '@/lib/api'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useToast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { useHealthText } from './healthText'
import { keepFixesFor, type DuplicateItemSet } from './duplicateItems'
import type { ModHealthStore } from './useModHealth'

export interface DuplicateItemsNoticeProps {
  set: DuplicateItemSet
  store: ModHealthStore
  canManage: boolean
  /** Non-null: the Keep buttons are disabled with this reason (e.g. unsaved load order). */
  blockedReason?: string | null
  modName: (modId: string) => string | undefined
  itemTitle: (workshopId: string) => string | undefined
  /** After a Keep wrote the server ini: the page reloads its config. */
  onFixed: (result: ModHealthFixResult) => void
  className?: string
}

/**
 * Two (or more) Workshop items that ship the same mods, in one sentence, with
 * "Keep <item>" for each: the health check's fix that takes the other items
 * out of WorkshopItems= (and the Mods= entries only they ship), after a
 * confirmation naming exactly what is removed, with a backup of the ini.
 */
export function DuplicateItemsNotice({ set, store, canManage, blockedReason = null, modName, itemTitle, onFixed, className }: DuplicateItemsNoticeProps) {
  const { t } = useTranslation('modHealth')
  const { toast } = useToast()
  const confirm = useConfirm()
  const found = keepFixesFor(store.health, set)
  // The page's item names first, then the Steam titles the health check knows.
  const titles = (found?.issue.params.titles && typeof found.issue.params.titles === 'object' ? found.issue.params.titles : {}) as Record<string, unknown>
  const titleOf = (workshopId: string) => itemTitle(workshopId) ?? (typeof titles[workshopId] === 'string' ? (titles[workshopId] as string) : undefined)
  const text = useHealthText({ modName, itemTitle: titleOf })
  const [busy, setBusy] = useState<string | null>(null)
  const reason = !canManage ? t('noPermission') : blockedReason

  const keep = async (issue: ModHealthIssue, fix: ModHealthFix) => {
    if (busy || reason) return
    const ok = await confirm({
      title: t('confirm.title'),
      description: text.confirmDescription(fix),
      items: text.removedTargets(fix),
      confirmLabel: t('confirm.remove'),
      destructive: true,
    })
    if (!ok) return
    setBusy(String(fix.params.keep))
    try {
      // A backupWarning on the answer is toasted by api.ts's handleResponse.
      const result = await store.applyFix(issue, fix)
      onFixed(result)
      toast(result.applied
        ? { title: t('toast.fixedTitle'), description: text.fixLabel(fix) }
        : { title: t('toast.unchangedTitle'), description: t('toast.unchangedDesc') })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MODS_HEALTH_ISSUE_GONE') {
        toast({ title: t('toast.goneTitle'), description: t('toast.goneDesc') })
        void store.reload()
      } else {
        toast({ title: t('toast.failedTitle'), description: getUserErrorMessage(error, t('toast.failedFallback')), variant: 'destructive' })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={cn('space-y-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2', className)} data-duplicate-items={set.key}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 flex-1 break-words text-sm text-foreground">{text.duplicateSentence(set.workshopIds, set.modIds)}</p>
      </div>
      {found && (
        <div className="flex flex-wrap items-center gap-2 ps-6">
          {found.fixes.map((fix) => {
            const keepId = String(fix.params.keep)
            return (
              <DisabledReason key={keepId} reason={reason}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void keep(found.issue, fix)}
                  disabled={busy !== null || !!reason}
                  className="h-auto min-h-11 max-w-full whitespace-normal py-1.5 text-start sm:min-h-8"
                >
                  {busy === keepId && <Loader2 className="animate-spin" aria-hidden="true" />}
                  <span className="min-w-0 break-words">{text.fixLabel(fix)}</span>
                </Button>
              </DisabledReason>
            )
          })}
        </div>
      )}
    </div>
  )
}
