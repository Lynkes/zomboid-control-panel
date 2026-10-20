import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedItem<T extends string = string> {
  value: T
  label: string
  count?: number
}

export interface SegmentedProps<T extends string = string> {
  value: T
  onValueChange: (value: T) => void
  items: SegmentedItem<T>[]
  ariaLabel: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * A small one-of-n filter (All / Modified / Unsaved). A radio group: one tab
 * stop, arrow keys move and select, like the native radio buttons it stands
 * in for.
 */
export function Segmented<T extends string = string>({ value, onValueChange, items, ariaLabel, size = 'sm', className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = Math.max(0, items.findIndex((item) => item.value === value))

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
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-0.5', className)}
    >
      {items.map((item, index) => {
        const checked = index === selectedIndex
        return (
          <button
            key={item.value}
            ref={(el) => { refs.current[index] = el }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              checked
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span className={cn('tabular-nums', checked ? 'text-muted-foreground' : 'text-muted-foreground/80')}>{item.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
