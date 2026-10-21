import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/components/ui/use-toast'
import { modsApi, type SaveModOrderResult } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'

// The server names conflicting groups by id; the admin knows them by name.
// Looked up when there is something to name (a failed lookup, or a group
// deleted meanwhile, falls back to the id).
async function groupNames(ids: string[]): Promise<string[]> {
  try {
    const { groups } = await modsApi.getGroups()
    const byId = new Map((groups ?? []).map((group) => [group.id, group.name]))
    return ids.map((id) => byId.get(id) || id)
  } catch (error) {
    reportClientWarning('Could not load mod group names for the save-order notice.', error)
    return ids
  }
}

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
    async (result: SaveModOrderResult | null | undefined) => {
      const adjusted = Array.isArray(result?.groupsAdjusted) ? result.groupsAdjusted.length : 0
      const conflictIds = Array.isArray(result?.groupConflicts) ? result.groupConflicts : []
      if (adjusted === 0 && conflictIds.length === 0) return
      const conflicts = conflictIds.length > 0 ? await groupNames(conflictIds) : []
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
      toast({
        title: t('toast.conflictsTitle'),
        description: t('toast.conflictsDesc', { items: conflicts.join(', ') }),
        variant: 'warning',
      })
    },
    [t, toast],
  )
}
