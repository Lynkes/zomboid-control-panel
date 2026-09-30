import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, RotateCcw, Upload, X, XCircle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import type { UploadItem } from './useUploadQueue'

interface UploadQueueProps {
  items: UploadItem[]
  pausedUntil: number | null
  allDone: boolean
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onCancelAll: () => void
  onClear: () => void
}

function usePauseSeconds(pausedUntil: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (pausedUntil === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pausedUntil])
  return pausedUntil === null ? 0 : Math.max(0, Math.ceil((pausedUntil - now) / 1000))
}

// The upload queue card (spec §A14.3): each file's progress, Cancel while
// it waits or runs, Try again once it failed or was cancelled. A 429 from
// the panel's rate limiter pauses the whole queue with a countdown instead
// of failing the rest of a folder upload.
export function UploadQueue({ items, pausedUntil, allDone, onCancel, onRetry, onCancelAll, onClear }: UploadQueueProps) {
  const { t } = useTranslation('files')
  const pauseSeconds = usePauseSeconds(pausedUntil)
  if (items.length === 0) return null
  const active = items.some((item) => item.status === 'waiting' || item.status === 'uploading')

  const statusText = (item: UploadItem): string => {
    switch (item.status) {
      case 'waiting':
        return pausedUntil !== null ? t('upload.paused', { seconds: pauseSeconds }) : t('upload.waiting')
      case 'uploading': {
        const percent = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0
        return t('upload.uploading', { percent })
      }
      case 'done':
        return t('upload.done')
      case 'failed':
        return t('upload.failed')
      case 'cancelled':
        return t('upload.cancelled')
      case 'skipped':
        return t('upload.skipped')
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('upload.queueTitle')}
        </CardTitle>
        {active ? (
          <Button variant="ghost" size="sm" onClick={onCancelAll}>{t('actions.cancel')}</Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onClear}>{t('actions.clearSelection')}</Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <p aria-live="polite" className="text-sm text-muted-foreground empty:hidden">{allDone ? t('upload.allDone') : ''}</p>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const percent = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0
            return (
              <li key={item.id} className="rounded-lg border border-border/60 bg-muted/25 p-2">
                <div className="flex items-center gap-2">
                  {item.status === 'done' ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : item.status === 'failed' ? (
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  ) : item.status === 'uploading' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <Upload className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <bdi dir="ltr" className="block truncate text-sm">{item.relPath}</bdi>
                    <span className={cn('block text-xs', item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                      {statusText(item)}
                      {item.error ? ` · ${item.error}` : ''}
                    </span>
                  </div>
                  {(item.status === 'waiting' || item.status === 'uploading') && (
                    <Button variant="ghost" size="iconDense" onClick={() => onCancel(item.id)} aria-label={`${t('actions.cancel')}: ${item.relPath}`}>
                      <X aria-hidden="true" />
                    </Button>
                  )}
                  {(item.status === 'failed' || item.status === 'cancelled') && item.profileId && (
                    <Button variant="ghost" size="iconDense" onClick={() => onRetry(item.id)} aria-label={`${t('actions.retry')}: ${item.relPath}`}>
                      <RotateCcw aria-hidden="true" />
                    </Button>
                  )}
                </div>
                {item.status === 'uploading' && <Progress value={percent} className="mt-2 h-1.5" aria-label={item.relPath} />}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

export type ReplaceChoice = 'replace' | 'skip' | 'cancel'

interface UploadReplaceDialogProps {
  open: boolean
  folder: string
  names: string[]
  onChoose: (choice: ReplaceChoice) => void
}

// The one "replace these?" prompt for a whole upload batch (spec §A14.3),
// not one per file: [Replace all] [Skip existing] [Cancel].
export function UploadReplaceDialog({ open, folder, names, onChoose }: UploadReplaceDialogProps) {
  const { t } = useTranslation('files')
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onChoose('cancel') }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('upload.existsTitle', { count: names.length, folder })}</AlertDialogTitle>
          <AlertDialogDescription>{t('upload.existsBody')}</AlertDialogDescription>
          <ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-3 ps-7 text-sm text-muted-foreground">
            {names.slice(0, 10).map((name) => (
              <li key={name} className="truncate"><bdi dir="ltr">{name}</bdi></li>
            ))}
            {names.length > 10 && <li className="list-none">…</li>}
          </ul>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel onClick={() => onChoose('cancel')}>{t('actions.cancel')}</AlertDialogCancel>
          <Button variant="outline" onClick={() => onChoose('skip')}>{t('upload.skipExisting')}</Button>
          <Button variant="warning" onClick={() => onChoose('replace')}>{t('upload.replaceAll')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
