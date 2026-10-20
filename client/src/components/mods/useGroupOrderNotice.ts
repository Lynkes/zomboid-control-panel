import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/components/ui/use-toast'
import type { SaveModOrderResult } from '@/lib/api'

/**
 * What to tell the admin about a POST /mods/save-order response. With "Keep
 * group order when saving" on, the server moves group members back into their
 * group order and lists the mods it moved in `groupsAdjusted`: the order that
 * was saved is then not the one that was on screen, so say so. Call it with
 * every save-order result; it does nothing when the order went through as sent.
 */
export function useGroupOrderNotice() {
  const { t } = useTranslation('modGroups')
  const { toast } = useToast()
  return useCallback(
    (result: SaveModOrderResult | null | undefined) => {
      const adjusted = Array.isArray(result?.groupsAdjusted) ? result.groupsAdjusted.length : 0
      const conflicts = Array.isArray(result?.groupConflicts) ? result.groupConflicts : []
      if (adjusted > 0) {
        toast({
          title: t('toast.orderKept', { count: adjusted }),
          description:
            conflicts.length > 0
              ? t('toast.orderKeptWithConflicts', { items: conflicts.join(', ') })
              : t('toast.orderKeptDesc'),
          variant: 'warning',
        })
        return
      }
      if (conflicts.length > 0) {
        toast({
          title: t('toast.conflictsTitle'),
          description: t('toast.conflictsDesc', { items: conflicts.join(', ') }),
          variant: 'warning',
        })
      }
    },
    [t, toast],
  )
}
