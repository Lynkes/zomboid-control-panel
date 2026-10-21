import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface PageAlert {
  id: string
  tone: 'error' | 'warning' | 'info'
  title: string
  description?: ReactNode
  /** The fix: a link to where it is fixed, or a button that does it. */
  action?: { label: string; onClick?: () => void; to?: string }
  onDismiss?: () => void
}

export interface PageAlertsProps {
  alerts: PageAlert[]
  /** How many show before "Show N more". */
  max?: number
  className?: string
}

const ORDER: Record<PageAlert['tone'], number> = { error: 0, warning: 1, info: 2 }

// DESIGN.md callouts: warning is amber-tinted with an amber title; info is
// the neutral instructional box; error is red-tinted with the title kept in
// the foreground colour (red text this small is too faint on the dark theme).
const TONE = {
  error: { box: 'border-destructive/40 bg-destructive/10', icon: AlertCircle, iconClass: 'text-destructive', title: 'text-foreground' },
  warning: { box: 'border-warning/40 bg-warning/10', icon: AlertTriangle, iconClass: 'text-warning', title: 'text-warning' },
  info: { box: 'border-border/60 bg-muted/40', icon: Info, iconClass: 'text-primary', title: 'text-foreground' },
} as const

/**
 * Everything a page needs to tell the operator before they work: one stack
 * under the header, errors first. Two show; the rest wait behind
 * "Show N more" so the page's content stays near the top.
 */
export function PageAlerts({ alerts, max = 2, className }: PageAlertsProps) {
  const { t } = useTranslation('shell')
  const [expanded, setExpanded] = useState(false)
  if (alerts.length === 0) return null

  const sorted = alerts
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => ORDER[a.alert.tone] - ORDER[b.alert.tone] || a.index - b.index)
    .map(({ alert }) => alert)
  const hiddenCount = Math.max(0, sorted.length - max)
  const shown = expanded ? sorted : sorted.slice(0, max)

  return (
    <div className={cn('space-y-2', className)}>
      {shown.map((alert) => {
        const tone = TONE[alert.tone]
        const Icon = tone.icon
        return (
          <div
            key={alert.id}
            role={alert.tone === 'error' ? 'alert' : 'status'}
            className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5', tone.box)}
          >
            <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone.iconClass)} aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className={cn('text-sm font-medium', tone.title)}>{alert.title}</p>
                {alert.description && <div className="text-sm text-muted-foreground">{alert.description}</div>}
              </div>
            </div>
            {(alert.action || alert.onDismiss) && (
              <div className="ms-auto flex shrink-0 items-center gap-1">
                {alert.action &&
                  (alert.action.to ? (
                    <Link to={alert.action.to} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      {alert.action.label}
                    </Link>
                  ) : (
                    <Button variant="outline" size="sm" onClick={alert.action.onClick}>
                      {alert.action.label}
                    </Button>
                  ))}
                {alert.onDismiss && (
                  <Button variant="ghost" size="iconDense" onClick={alert.onDismiss} aria-label={t('pageAlerts.dismiss')} title={t('pageAlerts.dismiss')}>
                    <X aria-hidden="true" />
                  </Button>
                )}
              </div>
            )}
          </div>
        )
      })}
      {hiddenCount > 0 && (
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? t('pageAlerts.showFewer') : t('pageAlerts.showMore', { count: hiddenCount })}
        </Button>
      )}
    </div>
  )
}
