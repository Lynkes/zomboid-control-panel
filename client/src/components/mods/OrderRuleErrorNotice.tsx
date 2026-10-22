import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OrderRuleErrorExplanation } from './orderRuleErrors'

/**
 * A refused rule, inline where it was asked for: the loop it would make,
 * link by link ("Brita requires TchernoLib"), or the cap, or the server's
 * own error. The error callout of DESIGN.md.
 */
export function OrderRuleErrorNotice({ explanation, className }: { explanation: OrderRuleErrorExplanation; className?: string }) {
  const { t } = useTranslation('modRules')
  return (
    <div role="alert" className={cn('flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm', className)}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">
        <p className="break-words font-medium text-foreground" dir="auto">{explanation.title}</p>
        {explanation.steps.length > 0 && (
          <ol className="list-decimal space-y-0.5 ps-5 text-xs text-foreground">
            {explanation.steps.map((step, index) => (
              <li key={index} className="break-words" dir="auto">{step}</li>
            ))}
          </ol>
        )}
        {explanation.kind === 'cycle' && <p className="text-xs text-muted-foreground">{t('errors.cycleHint')}</p>}
      </div>
    </div>
  )
}
