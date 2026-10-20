import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Plus, Search } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ModGroup } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { GroupDot } from './GroupDots'

export interface AddToGroupDialogProps {
  /** The mod IDs to add, in load order. */
  modIds: readonly string[]
  /** How the mods are named in the description: one mod's name, or none for several. */
  label?: string
  groups: readonly ModGroup[]
  /** Adds the mods to the group (at the end of its order). A rejection is shown in the dialog. */
  onAdd: (group: ModGroup) => Promise<void>
  /** Opens the group dialog with these mods as the new group's members. */
  onCreateNew: () => void
  onClose: () => void
}

/**
 * "Add to group…": pick an existing group for one or more mods, or start a new
 * one with them. A group that already lists every one of the mods is shown
 * but cannot be picked.
 */
export function AddToGroupDialog({ modIds, label, groups, onAdd, onCreateNew, onClose }: AddToGroupDialogProps) {
  const { t } = useTranslation('modGroups')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const count = new Set(modIds).size

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? groups.filter((group) => group.name.toLowerCase().includes(q)) : [...groups]
  }, [groups, query])

  const pick = async (group: ModGroup) => {
    setBusy(group.id)
    setError(null)
    try {
      await onAdd(group)
    } catch (err) {
      setError(getUserErrorMessage(err, t('addTo.failedFallback')))
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('addTo.title')}</DialogTitle>
          <DialogDescription>
            {label ? t('addTo.descriptionOne', { name: label }) : t('addTo.descriptionMany', { count })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {groups.length > 6 && (
            <div className="relative">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('addTo.search')}
                aria-label={t('addTo.search')}
                className="ps-8"
                autoFocus
              />
            </div>
          )}
          {groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">{t('addTo.noGroups')}</p>
          ) : shown.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t('addTo.noMatches')}</p>
          ) : (
            <ul className="max-h-72 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60" aria-label={t('addTo.listAria')}>
              {shown.map((group) => {
                const members = new Set(group.modIds)
                const already = modIds.every((id) => members.has(id))
                return (
                  <li key={group.id}>
                    <button
                      type="button"
                      onClick={() => void pick(group)}
                      disabled={already || busy !== null}
                      className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-start text-sm transition-colors hover:bg-accent/30 focus-visible:bg-accent/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <GroupDot color={group.color} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{group.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {already ? t('addTo.alreadyIn') : t('addTo.members', { count: group.modIds.length })}
                        </span>
                      </span>
                      {busy === group.id ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                      ) : already ? (
                        <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCreateNew} disabled={busy !== null} className="sm:me-auto">
            <Plus aria-hidden="true" />
            {t('addTo.newGroup')}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {t('addTo.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
