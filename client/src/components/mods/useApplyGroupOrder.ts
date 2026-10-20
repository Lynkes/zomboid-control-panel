import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { modsApi, type ModGroup } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

const LISTED_MOVES = 12

/**
 * "Apply group order": works on every group at once (they can overlap, so one
 * group cannot be put in order without looking at the rest). Asks the server
 * what would move, shows that, and writes it only after a yes.
 */
export function useApplyGroupOrder({
  groupsById,
  modNames,
  onApplied,
  onChecked,
}: {
  groupsById: ReadonlyMap<string, ModGroup>
  modNames: Readonly<Record<string, string>>
  /** After a write: the page reloads the load order. */
  onApplied: () => void | Promise<void>
  /** After a preview that found nothing to move: re-read the in-order status. */
  onChecked?: () => void | Promise<void>
}) {
  const { t } = useTranslation('modGroups')
  const { toast } = useToast()
  const confirm = useConfirm()
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)

  const conflictText = useCallback(
    (conflicts: readonly string[]) => conflicts.map((entry) => groupsById.get(entry)?.name ?? entry).join(', '),
    [groupsById],
  )

  const apply = useCallback(async () => {
    if (applyingRef.current) return
    applyingRef.current = true
    setApplying(true)
    try {
      const preview = await modsApi.applyGroups(true)
      if (!preview.changed || preview.moved.length === 0) {
        toast({
          title: t('apply.alreadyTitle'),
          description: preview.conflicts.length > 0
            ? t('apply.conflictsNote', { items: conflictText(preview.conflicts) })
            : t('apply.alreadyDesc'),
        })
        await onChecked?.()
        return
      }
      const moves = preview.moved.map((id) => (modNames[id] ? `${id} (${modNames[id]})` : id))
      const shown = moves.slice(0, LISTED_MOVES)
      if (moves.length > shown.length) shown.push(t('panel.andMore', { n: moves.length - shown.length }))
      const note = preview.conflicts.length > 0 ? `\n\n${t('apply.conflictsNote', { items: conflictText(preview.conflicts) })}` : ''
      const ok = await confirm({
        title: t('apply.confirmTitle'),
        description: t('apply.confirmDesc', { count: preview.moved.length }) + note,
        items: shown,
        confirmLabel: t('apply.confirm'),
        destructive: false,
      })
      if (!ok) return
      const result = await modsApi.applyGroups(false)
      if (!result.written) {
        toast({ title: t('apply.failedTitle'), description: t('apply.notWritten'), variant: 'destructive' })
        return
      }
      toast({ title: t('apply.appliedTitle'), description: t('apply.appliedDesc') })
      await onApplied()
    } catch (error) {
      toast({
        title: t('apply.failedTitle'),
        description: getUserErrorMessage(error, t('apply.failedFallback')),
        variant: 'destructive',
      })
    } finally {
      applyingRef.current = false
      setApplying(false)
    }
  }, [confirm, conflictText, modNames, onApplied, onChecked, t, toast])

  return { apply, applying }
}
