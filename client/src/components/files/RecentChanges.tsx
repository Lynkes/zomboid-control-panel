import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronDown, History, Loader2, XCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { filesApi } from '@/lib/filesApi'
import { cn } from '@/lib/utils'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import type { AuditEntry, AuditOp } from '@/types/files'
import { describeFilesError, describeResultError, formatFileDate } from './filesUi'

// history.ops keys: the audit op without "files.", dots as underscores.
function opKey(op: AuditOp | string): string {
  return `history.ops.${String(op).replace(/^files\./, '').replace(/\./g, '_')}`
}

interface RecentChangesProps {
  profileId: string
  /** Bumped after each change the page makes, to refetch while open. */
  refreshKey: number
}

// "Recent file changes" (spec §A14.3): the last 50 audit rows for this
// server, loaded only when the card is opened. The audit never holds file
// content. The operation and the folder are shown in the reader's language
// (an op the page doesn't know yet falls back to its id), the path as the
// server logged it, and a refused or failed row says why.
export function RecentChanges({ profileId, refreshKey }: RecentChangesProps) {
  const { t, i18n } = useTranslation('files')
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    setError(null)
    try {
      const result = await filesApi.getAudit(profileId, 50, signal)
      if (!signal.aborted) setEntries(result.entries)
    } catch (err) {
      if (!signal.aborted) {
        setEntries([])
        setError(describeFilesError(err))
      }
    }
  }, [profileId])

  useEffect(() => {
    setEntries(null)
  }, [profileId])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, open, refreshKey])

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="pb-4">
          <CollapsibleTrigger className="flex w-full items-center gap-2 rounded text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <History className="h-4 w-4 text-primary" aria-hidden="true" />
            <CardTitle className="flex-1 text-base">{t('history.title')}</CardTitle>
            <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-2">
            {entries === null ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            ) : error ? (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('history.empty')}</p>
            ) : (
              <ul className="max-h-80 space-y-1 overflow-y-auto">
                {entries.map((entry) => {
                  const firstPath = entry.paths[0] ?? ''
                  const rootLabel = entry.rootId ? t(`roots.labels.${entry.rootId}`) : ''
                  const where = [rootLabel, firstPath ? isolateLtrForRtl(firstPath) : ''].filter(Boolean).join(' / ')
                  const more = entry.paths.length > 1 ? ` (+${entry.paths.length - 1})` : ''
                  const op = i18n.exists(opKey(entry.op), { ns: 'files' }) ? t(opKey(entry.op)) : isolateLtrForRtl(entry.op)
                  const reason = entry.result !== 'ok' && entry.code ? describeResultError({ code: entry.code }) : null
                  return (
                    <li key={entry.id} className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
                      {entry.result === 'ok' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="break-words">
                          {t('history.entry', {
                            username: entry.actor.username ?? '—',
                            op,
                            path: `${where}${more}`,
                          })}
                        </p>
                        {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
                        <p className="text-xs text-muted-foreground">{formatFileDate(entry.at, i18n.language)}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
