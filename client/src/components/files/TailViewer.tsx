import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, KeyRound, Loader2, RefreshCw, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { filesApi } from '@/lib/filesApi'
import { formatBytes } from '@/lib/formatBytes'
import type { FileEntry, RootDescriptor } from '@/types/files'
import { describeFilesError } from './filesUi'

interface TailViewerProps {
  open: boolean
  profileId: string
  root: RootDescriptor
  entry: FileEntry
  canDownload: boolean
  onDownload: () => void
  onClose: () => void
}

// The end of a file too large for the editor, typically a server log
// (spec §A6.1 mode=tail): the last 256 KiB, read-only, scrolled to the
// bottom. Passwords in an .ini are masked here too.
export function TailViewer({ open, profileId, root, entry, canDownload, onDownload, onClose }: TailViewerProps) {
  const { t, i18n } = useTranslation('files')
  const [content, setContent] = useState<string | null>(null)
  const [masked, setMasked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await filesApi.getText(profileId, { root: root.id, path: entry.path, mode: 'tail' })
      setContent(result.content)
      setMasked(result.masked)
    } catch (err) {
      setError(describeFilesError(err))
    } finally {
      setLoading(false)
    }
  }, [entry.path, profileId, root.id])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  useEffect(() => {
    if (content !== null && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [content])

  const shownSize = content === null ? '' : formatBytes(new TextEncoder().encode(content).length, i18n.language)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:rounded-lg [&>button:last-child]:hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">
              <bdi dir="ltr">{entry.name}</bdi>
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              {content !== null ? t('editor.tailView', { size: shownSize }) : <bdi dir="ltr" className="font-mono">{entry.path}</bdi>}
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {t('actions.reload')}
            </Button>
            {canDownload && (
              <Button variant="outline" size="sm" onClick={onDownload}>
                <Download aria-hidden="true" />
                {t('actions.download')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X aria-hidden="true" />
              {t('actions.close')}
            </Button>
          </div>
        </div>
        {masked && (
          <div className="px-4 pt-3">
            <Alert className="border-border/60 bg-muted/40">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <AlertDescription className="text-muted-foreground">{t('editor.hints.secretsMasked')}</AlertDescription>
            </Alert>
          </div>
        )}
        <div className="min-h-0 flex-1 p-4">
          {loading && content === null ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p role="alert" className="max-w-md text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>{t('actions.retry')}</Button>
            </div>
          ) : (
            <pre
              ref={preRef}
              dir="ltr"
              tabIndex={0}
              aria-label={entry.name}
              className="h-full overflow-auto whitespace-pre rounded-md border border-border/60 bg-input px-3 py-3 font-mono text-[13px] leading-5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
