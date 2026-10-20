import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import type { ModHealth } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * One line at the top of Active on server and Load order when the health
 * check found problems: "2 problems will stop mods from loading · 3 warnings
 * · Review". Error tone with critical problems, warning tone otherwise;
 * nothing at all when there are none.
 */
export function HealthSummaryCard({ health, onReview, className }: { health: ModHealth | null; onReview: () => void; className?: string }) {
  const { t } = useTranslation('modHealth')
  const critical = health?.counts.critical ?? 0
  const warning = health?.counts.warning ?? 0
  if (critical + warning === 0) return null

  const error = critical > 0
  const Icon = error ? AlertCircle : AlertTriangle
  const parts = [
    critical > 0 ? t('summary.critical', { count: critical }) : t('summary.warningOnly', { count: warning }),
    critical > 0 && warning > 0 ? t('summary.warning', { count: warning }) : null,
  ].filter((part): part is string => !!part)

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2',
        error ? 'border-destructive/40 bg-destructive/10' : 'border-warning/40 bg-warning/10',
        className,
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', error ? 'text-destructive' : 'text-warning')} aria-hidden="true" />
      <p className={cn('min-w-0 flex-1 text-sm font-medium', error ? 'text-foreground' : 'text-warning')}>
        {parts.join(' · ')}
      </p>
      <Button variant="outline" size="sm" onClick={onReview} aria-label={t('summary.reviewAria')}>
        {t('summary.review')}
      </Button>
    </div>
  )
}
