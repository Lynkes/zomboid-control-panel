import { useTranslation } from 'react-i18next'
import { Download, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/formatBytes'
import type { FileEntry } from '@/types/files'
import { cn } from '@/lib/utils'
import { MOBILE_FULL_SCREEN } from './NameDialog'
import { formatFileDate } from './filesUi'

interface FileDetailsPopoverProps {
  open: boolean
  entry: FileEntry
  canDownload: boolean
  canReplace: boolean
  onDownload: () => void
  onReplace: () => void
  onClose: () => void
}

// What opening a binary or special file shows (spec §A14.3): its size and
// date, Download, and "Replace by upload". A small dialog rather than an
// anchored popover: the client has no popover primitive, and a dialog also
// works the same with a keyboard and on a phone.
export function FileDetailsPopover({ open, entry, canDownload, canReplace, onDownload, onReplace, onClose }: FileDetailsPopoverProps) {
  const { t, i18n } = useTranslation('files')
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className={cn('max-w-md', MOBILE_FULL_SCREEN)}>
        <DialogHeader>
          <DialogTitle className="break-all">
            <bdi dir="ltr">{t('dialogs.details.title', { name: entry.name })}</bdi>
          </DialogTitle>
          <DialogDescription>{t('dialogs.details.binary')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
          <dt className="text-muted-foreground">{t('dialogs.details.size')}</dt>
          <dd className="tabular-nums">{formatBytes(entry.size, i18n.language) || '—'}</dd>
          <dt className="text-muted-foreground">{t('dialogs.details.modified')}</dt>
          <dd>{formatFileDate(entry.modifiedAt, i18n.language) || '—'}</dd>
        </dl>
        <DialogFooter className="gap-2">
          {canReplace && (
            <Button variant="outline" onClick={() => { if (canReplace) onReplace() }}>
              <Upload aria-hidden="true" />
              {t('actions.replaceByUpload')}
            </Button>
          )}
          {canDownload && (
            <Button onClick={() => { if (canDownload) onDownload() }}>
              <Download aria-hidden="true" />
              {t('actions.download')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
