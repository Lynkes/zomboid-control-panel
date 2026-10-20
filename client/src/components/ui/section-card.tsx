import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { readStored, writeStored } from '@/lib/safeStorage'
import { cn } from '@/lib/utils'

export interface SectionCardProps {
  title: ReactNode
  description?: ReactNode
  icon?: LucideIcon
  /** Live state next to the title (a StatusPill, a count). */
  status?: ReactNode
  /** Buttons at the header's end. Never inside the collapse toggle. */
  actions?: ReactNode
  footer?: ReactNode
  /** p-5 (default) or p-4 (compact). */
  density?: 'default' | 'compact'
  /** No body padding: tables, terminals, lists that run edge to edge. */
  flush?: boolean
  headingLevel?: 2 | 3
  collapsible?: boolean
  defaultOpen?: boolean
  /** Remembers a collapsible card's open state in this browser. */
  storageKey?: string
  id?: string
  className?: string
  children?: ReactNode
}

function readOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback
  const stored = readStored(storageKey)
  return stored === 'true' ? true : stored === 'false' ? false : fallback
}

/**
 * The one container for a block of a page: a titled card. Never nest one in
 * another; inside a SectionCard use a grouped block
 * (`rounded-xl border border-border/70 bg-background/40 p-4`) or a
 * `border-t` divider (DESIGN.md).
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  status,
  actions,
  footer,
  density = 'default',
  flush = false,
  headingLevel = 2,
  collapsible = false,
  defaultOpen = true,
  storageKey,
  id,
  className,
  children,
}: SectionCardProps) {
  const headingId = useId()
  const [open, setOpenState] = useState(() => readOpen(storageKey, defaultOpen))
  const setOpen = (next: boolean) => {
    setOpenState(next)
    if (storageKey) writeStored(storageKey, String(next))
  }
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const pad = density === 'compact' ? 'p-4' : 'p-5'
  const padX = density === 'compact' ? 'px-4' : 'px-5'
  const isOpen = collapsible ? open : true

  const titleRow = (
    <span className="flex min-w-0 items-center gap-2">
      {Icon && <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
      <span className="min-w-0 text-base font-semibold leading-tight text-foreground">{title}</span>
    </span>
  )

  const header = (
    <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2', pad, children !== undefined && isOpen && 'pb-0')}>
      {/* A floor on the title column: with a 0 basis alone it shrank to a
          word per line before the actions would wrap below it on a phone. */}
      <div className="min-w-[min(100%,14rem)] flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Heading id={headingId} className="min-w-0">
            {collapsible ? (
              <CollapsibleTrigger className="group -mx-1 flex items-center gap-1.5 rounded-md px-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70">
                {titleRow}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90 rtl:group-data-[state=closed]:rotate-90" aria-hidden="true" />
              </CollapsibleTrigger>
            ) : (
              titleRow
            )}
          </Heading>
          {status}
        </div>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )

  const body = children !== undefined && (
    <div className={cn(flush ? 'mt-4 border-t border-border/60' : cn(pad, 'space-y-4 pt-4'))}>{children}</div>
  )
  const foot = footer && (
    <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-border/60 py-3', padX)}>{footer}</div>
  )

  const classes = cn('rounded-xl border border-border/60 bg-card text-card-foreground', className)

  if (!collapsible) {
    return (
      <section id={id} aria-labelledby={headingId} className={classes}>
        {header}
        {body}
        {foot}
      </section>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section id={id} aria-labelledby={headingId} className={classes}>
        {header}
        <CollapsibleContent>
          {body}
          {foot}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
