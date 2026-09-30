import { useTranslation } from 'react-i18next'
import { FileArchive, FolderInput, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface BulkBarProps {
  count: number
  canDownload: boolean
  canMutate: boolean
  onDownloadZip: () => void
  onMove: () => void
  onDelete: () => void
  onClear: () => void
}

// "N selected · Download as .zip · Move · Delete · Clear" (spec §A14.2).
// Sticks to the bottom of the list card on desktop, and to the bottom of the
// screen on a phone, where the list scrolls inside its card and a bar inside
// it would scroll away. Move and Delete only show when every selected item
// can be changed; the server re-checks each one anyway.
export function BulkBar({ count, canDownload, canMutate, onDownloadZip, onMove, onDelete, onClear }: BulkBarProps) {
  const { t } = useTranslation('files')
  if (count === 0) return null
  return (
    <div
      role="region"
      aria-label={t('list.selected', { count })}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/95 px-4 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 md:sticky md:inset-x-auto md:bottom-0 md:rounded-lg md:border md:px-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="me-auto text-sm font-medium" aria-live="polite">{t('list.selected', { count })}</span>
        {canDownload && (
          <Button variant="outline" size="sm" onClick={() => { if (canDownload) onDownloadZip() }}>
            <FileArchive aria-hidden="true" />
            {t('actions.downloadZip')}
          </Button>
        )}
        {canMutate && (
          <Button variant="outline" size="sm" onClick={() => { if (canMutate) onMove() }}>
            <FolderInput aria-hidden="true" />
            {t('actions.move')}
          </Button>
        )}
        {canMutate && (
          <Button variant="destructive" size="sm" onClick={() => { if (canMutate) onDelete() }}>
            <Trash2 aria-hidden="true" />
            {t('actions.delete')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden="true" />
          {t('actions.clearSelection')}
        </Button>
      </div>
    </div>
  )
}
