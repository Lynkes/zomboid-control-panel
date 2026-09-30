import { useTranslation } from 'react-i18next'
import { UploadCloud } from 'lucide-react'

interface DropOverlayProps {
  visible: boolean
  /** The destination folder, as the page names it: its path part already isolated left-to-right. */
  folder: string
}

// Shown over the file list while files are dragged onto it (spec §A14.3),
// naming the folder they'll land in. Desktop only: the page doesn't wire
// drag and drop on a phone.
export function DropOverlay({ visible, folder }: DropOverlayProps) {
  const { t } = useTranslation('files')
  if (!visible) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/85 p-6 text-center backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <UploadCloud className="h-10 w-10 text-primary" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">{t('upload.dropHere', { folder })}</p>
      </div>
    </div>
  )
}
