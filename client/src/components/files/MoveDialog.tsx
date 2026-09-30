import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, ChevronRight, Folder, Loader2 } from 'lucide-react'
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
import { filesApi, parentPath } from '@/lib/filesApi'
import type { FileEntry, RootDescriptor } from '@/types/files'
import { MOBILE_FULL_SCREEN } from './NameDialog'
import { describeFilesError, isFolderLike } from './filesUi'

interface MoveDialogProps {
  open: boolean
  profileId: string
  root: RootDescriptor
  rootLabel: string
  /** Root-relative paths of the items being moved. */
  paths: string[]
  /** Where the picker opens. */
  startDir: string
  onCancel: () => void
  /** Throws to keep the dialog open with the error shown. */
  onMove: (destDir: string) => Promise<void>
}

function isInsideAny(dir: string, paths: string[]): boolean {
  return paths.some((path) => dir === path || dir.startsWith(`${path}/`))
}

// "Move…" (spec §A14.3): a small folder picker over the same /list route,
// folders only and within the same root (moves never cross roots). Folders
// being moved, and anything inside them, aren't offered as destinations,
// and neither is the folder the items already sit in (search results can
// sit anywhere below the folder the picker opens on, so that is judged by
// the items' own folders, not by where the picker started).
export function MoveDialog({ open, profileId, root, rootLabel, paths, startDir, onCancel, onMove }: MoveDialogProps) {
  const { t } = useTranslation('files')
  const [dir, setDir] = useState(startDir)
  const [folders, setFolders] = useState<FileEntry[]>([])
  const [folderEmpty, setFolderEmpty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setDir(startDir)
      setError(null)
      setBusy(false)
    }
  }, [open, startDir])

  const load = useCallback(async (path: string, signal: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const result = await filesApi.list(profileId, { root: root.id, path, sort: 'name', order: 'asc', limit: 1000 }, signal)
      if (signal.aborted) return
      setFolderEmpty(result.entries.length === 0)
      setFolders(result.entries.filter((entry) =>
        isFolderLike(entry) && entry.protection === null && !entry.flags.unsupportedName && !isInsideAny(entry.path, paths),
      ))
    } catch (err) {
      if (signal.aborted) return
      setFolders([])
      setFolderEmpty(false)
      setError(describeFilesError(err))
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [paths, profileId, root.id])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void load(dir, controller.signal)
    return () => controller.abort()
  }, [dir, load, open])

  const alreadyThere = paths.length > 0 && paths.every((path) => parentPath(path) === dir)
  const canMoveHere = !alreadyThere && !isInsideAny(dir, paths) && !busy

  const submit = async () => {
    if (!canMoveHere) return
    setBusy(true)
    setError(null)
    try {
      await onMove(dir)
    } catch (err) {
      setError(describeFilesError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <DialogContent className={MOBILE_FULL_SCREEN}>
        <DialogHeader>
          <DialogTitle>{t('dialogs.move.title', { count: paths.length })}</DialogTitle>
          <DialogDescription>{t('dialogs.move.hint')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('dialogs.move.destLabel')}</p>
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/25 p-2 text-sm">
            <Button
              variant="ghost"
              size="iconDense"
              onClick={() => setDir(parentPath(dir))}
              disabled={dir === '' || loading}
              aria-label={t('list.parent')}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <span className="min-w-0 truncate">
              {rootLabel}
              {dir && (
                <>
                  {' / '}
                  <bdi dir="ltr" className="font-mono">{dir}</bdi>
                </>
              )}
            </span>
          </div>
          <div className="min-h-[8rem] rounded-lg border border-border/60">
            {loading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            ) : folders.length === 0 ? (
              folderEmpty && <p className="p-4 text-center text-sm text-muted-foreground">{t('list.empty.title')}</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto py-1">
                {folders.map((folder) => (
                  <li key={folder.path}>
                    <button
                      type="button"
                      onClick={() => setDir(folder.path)}
                      className="flex min-h-11 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:min-h-9"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      <bdi dir="ltr" className="min-w-0 flex-1 truncate">{folder.name}</bdi>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>{t('actions.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={!canMoveHere}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('actions.move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
