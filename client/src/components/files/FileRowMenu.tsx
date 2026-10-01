import { useTranslation } from 'react-i18next'
import {
  ClipboardCopy,
  Copy,
  Download,
  Eye,
  FileArchive,
  FolderInput,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  PencilLine,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FileEntry } from '@/types/files'
import type { OpenMode } from './filesUi'

export type RowAction = 'open' | 'download' | 'rename' | 'move' | 'duplicate' | 'copyPath' | 'delete' | 'deletePermanently'

interface FileRowMenuProps {
  entry: FileEntry
  openMode: OpenMode
  canMutate: boolean
  canRead: boolean
  onAction: (action: RowAction, entry: FileEntry) => void
}

// The per-row "…" menu (spec §A14.2). Items the operator can't use on this
// entry are left out rather than disabled: a read-only root or a protected
// entry has no Rename/Move/Delete at all. Every item's onSelect re-checks
// the same flag it was rendered on, since a Radix item runs its handler even
// when disabled.
export function FileRowMenu({ entry, openMode, canMutate, canRead, onAction }: FileRowMenuProps) {
  const { t } = useTranslation('files')
  const isFolder = openMode === 'enter'
  const isFile = entry.type === 'file' || (entry.type === 'link' && entry.link?.targetType === 'file')

  const openLabel =
    openMode === 'edit' ? (canMutate ? t('actions.edit') : t('actions.view'))
      : openMode === 'tail' ? t('actions.view')
        : t('actions.open')
  const OpenIcon = openMode === 'edit' && canMutate ? Pencil : openMode === 'enter' ? FolderOpen : Eye

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="iconDense" aria-label={t('actions.more', { name: entry.name })}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {openMode !== 'blocked' && (
          <DropdownMenuItem onSelect={() => onAction('open', entry)} className="min-h-11 gap-2 sm:min-h-0">
            <OpenIcon className="h-4 w-4" aria-hidden="true" />
            {openLabel}
          </DropdownMenuItem>
        )}
        {canRead && (
          <DropdownMenuItem onSelect={() => { if (canRead) onAction('download', entry) }} className="min-h-11 gap-2 sm:min-h-0">
            {isFolder ? <FileArchive className="h-4 w-4" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            {isFolder ? t('actions.downloadZip') : t('actions.download')}
          </DropdownMenuItem>
        )}
        {canMutate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { if (canMutate) onAction('rename', entry) }} className="min-h-11 gap-2 sm:min-h-0">
              <PencilLine className="h-4 w-4" aria-hidden="true" />
              {t('actions.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { if (canMutate) onAction('move', entry) }} className="min-h-11 gap-2 sm:min-h-0">
              <FolderInput className="h-4 w-4" aria-hidden="true" />
              {t('actions.move')}
            </DropdownMenuItem>
            {isFile && (
              <DropdownMenuItem onSelect={() => { if (canMutate && isFile) onAction('duplicate', entry) }} className="min-h-11 gap-2 sm:min-h-0">
                <Copy className="h-4 w-4" aria-hidden="true" />
                {t('actions.duplicate')}
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuItem onSelect={() => onAction('copyPath', entry)} className="min-h-11 gap-2 sm:min-h-0">
          <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
          {t('page.copyPath')}
        </DropdownMenuItem>
        {canMutate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => { if (canMutate) onAction('delete', entry) }}
              className="min-h-11 gap-2 text-destructive focus:text-destructive sm:min-h-0"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t('actions.delete')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => { if (canMutate) onAction('deletePermanently', entry) }}
              className="min-h-11 gap-2 text-destructive focus:text-destructive sm:min-h-0"
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
              {t('actions.deletePermanently')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
