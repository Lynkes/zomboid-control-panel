import { useTranslation } from 'react-i18next'
import { Check, Lock } from 'lucide-react'
import { DisabledReason } from '@/components/DisabledReason'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type StepStatus = 'done' | 'current' | 'upcoming' | 'locked'

export interface StepperStep {
  id: string
  label: string
  status: StepStatus
  /** Why a locked step can't be opened yet. */
  lockedReason?: string
}

export interface StepperProps {
  steps: StepperStep[]
  /** When set, every step that isn't locked is a button. */
  onStepClick?: (id: string) => void
  className?: string
}

const MARKER: Record<StepStatus, string> = {
  done: 'border-primary/50 bg-primary/15 text-primary',
  current: 'border-primary bg-primary text-primary-foreground',
  upcoming: 'border-border bg-background text-muted-foreground',
  locked: 'border-border/60 bg-muted/40 text-muted-foreground/70',
}

/**
 * Where a wizard is: numbered steps with done / current / upcoming / locked
 * states. Below `sm` only the current step's label shows, next to its
 * position ("Step 2 of 4").
 */
export function Stepper({ steps, onStepClick, className }: StepperProps) {
  const { t } = useTranslation('shell')
  const currentIndex = steps.findIndex((step) => step.status === 'current')

  return (
    <nav aria-label={t('stepper.ariaLabel')} className={className}>
      {currentIndex >= 0 && (
        <p className="mb-2 text-xs text-muted-foreground sm:hidden">
          {t('stepper.position', { current: currentIndex + 1, total: steps.length })}
          <span className="text-foreground"> · {steps[currentIndex].label}</span>
        </p>
      )}
      <ol className="flex items-center gap-2">
        {steps.map((step, index) => {
          const interactive = !!onStepClick && step.status !== 'locked'
          const marker = (
            <span
              className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums', MARKER[step.status])}
              aria-hidden="true"
            >
              {step.status === 'done' ? <Check className="h-3.5 w-3.5" /> : step.status === 'locked' ? <Lock className="h-3 w-3" /> : index + 1}
            </span>
          )
          // Visible from sm up; below that the line above names the current
          // step and the labels stay for screen readers only.
          const label = (
            <span
              className={cn(
                'sr-only truncate text-sm sm:not-sr-only',
                step.status === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {step.label}
            </span>
          )
          const content = (
            <>
              {marker}
              {label}
              <span className="sr-only"> ({t(`stepper.status.${step.status}`)})</span>
            </>
          )
          const common = 'flex min-w-0 items-center gap-2 rounded-md'
          let body
          if (interactive) {
            body = (
              <button
                type="button"
                onClick={() => onStepClick?.(step.id)}
                aria-current={step.status === 'current' ? 'step' : undefined}
                className={cn(common, 'px-1 py-1 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70')}
              >
                {content}
              </button>
            )
          } else {
            body = (
              <span aria-current={step.status === 'current' ? 'step' : undefined} className={cn(common, 'px-1 py-1')}>
                {content}
              </span>
            )
            if (step.status === 'locked' && step.lockedReason) {
              body = (
                <TooltipProvider delayDuration={150}>
                  <DisabledReason reason={step.lockedReason}>{body}</DisabledReason>
                </TooltipProvider>
              )
            }
          }
          return (
            <li key={step.id} className={cn('flex min-w-0 items-center gap-2', step.status === 'current' ? 'shrink-0' : 'shrink')}>
              {index > 0 && (
                <span
                  className={cn('h-px w-4 shrink-0 sm:w-8', steps[index - 1].status === 'done' ? 'bg-primary/50' : 'bg-border')}
                  aria-hidden="true"
                />
              )}
              {body}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
