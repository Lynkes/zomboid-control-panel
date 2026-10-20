import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import type { SteamKnowledgeStatus } from '@/lib/api'
import { useDateFormat } from '@/lib/dateFormat'
import { cn } from '@/lib/utils'
import { formatAge } from './smartText'

/**
 * Where the panel's Steam knowledge (Workshop tags, "Required items",
 * titles) stands: "Steam data from 3 hr. ago · Refresh". Smart sort, the
 * kinds and the health check read it, so a stale or missing answer is said
 * next to their results.
 */
export function SteamStatusLine({
  status,
  onRefresh,
  refreshing = false,
  className,
}: {
  status: SteamKnowledgeStatus | null | undefined
  onRefresh?: () => void
  refreshing?: boolean
  className?: string
}) {
  const { t } = useTranslation('modsSmart')
  const { locale } = useDateFormat()
  if (!status || status.total === 0) return null
  const age = formatAge(status.fetchedAt, locale)

  let text: string
  if (status.rateLimited) text = t('steam.rateLimited')
  else if (status.failed) text = t('steam.failed')
  else if (!age || status.source === 'none') text = status.pending ? t('steam.pending') : t('steam.none')
  else text = t('steam.from', { age })

  const coverage = status.known < status.total ? t('steam.coverage', { known: status.known, total: status.total }) : null

  return (
    <p className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground', className)}>
      <span>{text}</span>
      {status.stale && !status.failed && age && <span className="text-warning">{t('steam.stale')}</span>}
      {coverage && <span>· {coverage}</span>}
      {status.pending && age && (
        <span className="inline-flex items-center gap-1">
          · <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> {t('steam.updating')}
        </span>
      )}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex h-7 items-center gap-1 rounded px-1.5 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-60"
        >
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
          {t('steam.refresh')}
        </button>
      )}
    </p>
  )
}
