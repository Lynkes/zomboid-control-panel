import { useRef, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface OptionGridItem<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
}

interface OptionGridProps<T extends string> {
  /** null: nothing chosen yet; the first option takes the tab stop. */
  value: T | null
  onValueChange: (value: T) => void
  items: OptionGridItem<T>[]
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
  id?: string
  className?: string
}

/**
 * A one-of-n choice laid out as a grid of tiles: the Scheduler dialog's task
 * type and schedule mode. A radio group like Segmented (one tab stop, arrow
 * keys move and select) for choices that need room or an icon.
 */
export function OptionGrid<T extends string>({ value, onValueChange, items, ariaLabel, ariaLabelledBy, ariaDescribedBy, id, className }: OptionGridProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = items.findIndex((item) => item.value === value)
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl'
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
    const back = rtl ? 'ArrowRight' : 'ArrowLeft'
    let next: number | null = null
    if (event.key === forward || event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === back || event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === null) return
    event.preventDefault()
    onValueChange(items[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className={cn('grid gap-2', className)}
    >
      {items.map((item, index) => {
        const checked = index === selectedIndex
        const Icon = item.icon
        return (
          <button
            key={item.value}
            ref={(el) => { refs.current[index] = el }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'flex min-h-11 min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
              Icon && 'sm:flex-col sm:items-start sm:gap-1.5 sm:py-2.5',
              checked
                ? 'border-primary/60 bg-primary/10 text-foreground'
                : 'border-border/60 bg-muted/25 text-muted-foreground hover:border-border hover:bg-accent/30 hover:text-foreground',
            )}
          >
            {Icon && <Icon className={cn('h-4 w-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
