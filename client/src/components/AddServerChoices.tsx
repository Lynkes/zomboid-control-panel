import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { DisabledReason } from '@/components/DisabledReason'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAddServerChoices, type AddServerChoice } from '@/lib/addServerChoices'
import { cn } from '@/lib/utils'

// The list of the three ways to add a server (lib/addServerChoices.ts holds
// the choices, their words and their default links).

export interface AddServerChoicesProps {
  /** A handler replaces the default link for that choice (the Servers page opens its dialog in place). */
  onChoose?: Partial<Record<AddServerChoice, () => void>>
  /** Marks the choice that fits this install best ("Recommended"). */
  recommended?: AddServerChoice
  /** A reason disables that choice and is shown under it. */
  disabledReasons?: Partial<Record<AddServerChoice, string | null | undefined>>
  /** Extra lines under a choice's description (download size, what gets set up). */
  details?: Partial<Record<AddServerChoice, ReactNode>>
  /** Leave a choice out (the Add a Server page has no remote flow of its own, but still links to it). */
  hide?: AddServerChoice[]
  className?: string
}

/**
 * The three ways to add a server, as one list of rows: icon, label, one
 * sentence, chevron. A row is a link (or a button when `onChoose` has a
 * handler for it).
 */
export function AddServerChoices({ onChoose, recommended, disabledReasons, details, hide, className }: AddServerChoicesProps) {
  const { t } = useTranslation('servers')
  const choices = useAddServerChoices().filter((choice) => !hide?.includes(choice.id))

  return (
    <TooltipProvider delayDuration={150}>
      <ul aria-label={t('addServer.listLabel')} className={cn('grid gap-2', className)}>
        {choices.map((choice) => {
          const Icon = choice.icon
          const isRecommended = recommended === choice.id
          const reason = disabledReasons?.[choice.id] || undefined
          const handler = onChoose?.[choice.id]
          const rowClass = cn(
            'group flex w-full items-start gap-3 rounded-lg border p-3 text-start transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
            isRecommended ? 'border-primary/40 bg-primary/5' : 'border-border/60 bg-background/40',
            reason ? 'cursor-not-allowed' : 'hover:border-primary/50 hover:bg-accent/20',
          )
          const body = (
            <>
              <span
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-md border',
                  isRecommended ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border/60 bg-muted/40 text-muted-foreground group-hover:text-primary',
                )}
                aria-hidden="true"
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-sm font-medium', reason ? 'text-muted-foreground' : 'text-foreground')}>{choice.label}</span>
                  {isRecommended && (
                    <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {t('addServer.recommended')}
                    </span>
                  )}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">{choice.description}</span>
                {details?.[choice.id] && <span className="block pt-1 text-xs leading-5 text-muted-foreground">{details[choice.id]}</span>}
                {reason && <span className="block pt-1 text-xs font-medium leading-5 text-foreground">{reason}</span>}
              </span>
              <ChevronRight
                className="mt-2.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                aria-hidden="true"
              />
            </>
          )
          let row: ReactNode
          if (reason) {
            row = (
              <DisabledReason reason={reason} className="w-full">
                <button type="button" disabled className={rowClass}>
                  {body}
                </button>
              </DisabledReason>
            )
          } else if (handler) {
            row = (
              <button type="button" onClick={handler} className={rowClass}>
                {body}
              </button>
            )
          } else {
            row = (
              <Link to={choice.to} className={rowClass}>
                {body}
              </Link>
            )
          }
          return (
            <li key={choice.id} className="min-w-0">
              {row}
            </li>
          )
        })}
      </ul>
    </TooltipProvider>
  )
}
