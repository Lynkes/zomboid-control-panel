import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface StatStripItem {
  id: string
  label: string
  value: ReactNode
  detail?: ReactNode
  icon?: LucideIcon
  tone?: 'default' | 'success' | 'warning' | 'danger'
  onClick?: () => void
  to?: string
  /** Accessible name for a clickable cell when label + value don't say where it goes. */
  ariaLabel?: string
}

export interface StatStripProps {
  items: StatStripItem[]
  className?: string
}

// Tone colours the icon; success and warning also colour the number. Red
// text at this size is too faint on the dark theme, so danger keeps the
// number in the foreground colour and lets the icon carry the colour.
const ICON_TONE = {
  default: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
} as const

const VALUE_TONE = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-foreground',
} as const

const CELL = 'flex h-full min-w-0 flex-col gap-1 bg-card px-4 py-3'
const INTERACTIVE =
  'text-start transition-colors hover:bg-accent/20 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70'

/**
 * A page's summary numbers in one bordered row: no cards, no tile grid. One
 * row with 1px dividers from `sm` up, a two-column grid on phones. A cell
 * with `to` or `onClick` is a link or a button.
 */
export function StatStrip({ items, className }: StatStripProps) {
  if (items.length === 0) return null
  return (
    <ul
      role="list"
      className={cn(
        // gap-px over a border-coloured background draws the dividers in both
        // layouts; an odd last cell spans the phone grid's full width.
        'grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60',
        'sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none',
        '[&>li:last-child:nth-child(odd)]:col-span-2 sm:[&>li:last-child:nth-child(odd)]:col-span-1',
        className,
      )}
    >
      {items.map((item) => {
        const tone = item.tone ?? 'default'
        const Icon = item.icon
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              {Icon && <Icon className={cn('h-4 w-4 shrink-0', ICON_TONE[tone])} aria-hidden="true" />}
              <span className="label-micro truncate">{item.label}</span>
            </span>
            <span className={cn('text-xl font-semibold leading-tight tabular-nums', VALUE_TONE[tone])}>{item.value}</span>
            {item.detail && <span className="truncate text-xs text-muted-foreground">{item.detail}</span>}
          </>
        )
        return (
          <li key={item.id} className="min-w-0">
            {item.to ? (
              <Link to={item.to} aria-label={item.ariaLabel} className={cn(CELL, INTERACTIVE)}>
                {body}
              </Link>
            ) : item.onClick ? (
              <button type="button" onClick={item.onClick} aria-label={item.ariaLabel} className={cn(CELL, INTERACTIVE, 'w-full')}>
                {body}
              </button>
            ) : (
              <div className={CELL}>{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
