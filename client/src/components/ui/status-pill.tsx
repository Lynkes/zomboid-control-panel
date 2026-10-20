import * as React from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'idle' | 'busy'

export interface StatusPillProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title' | 'children'> {
  tone: StatusTone
  /** The state in a word or two ("Running", "Bridge offline"). */
  label: string
  /** Why, in a few words ("Authentication failed"); muted, after the label. */
  detail?: string
  /** Pulses the dot: for states that are about to change (waiting, reconnecting). */
  pulse?: boolean
  size?: 'sm' | 'md'
  /** Makes the pill a link to where the state can be fixed. */
  to?: string
  title?: string
}

// Colour lives in the dot, the tint and the border. The label stays in the
// foreground colour: red or green text at this size is too faint on the dark
// theme to read under stress.
const TONE: Record<StatusTone, { surface: string; dot: string; text: string }> = {
  ok: { surface: 'border-success/30 bg-success/10', dot: 'bg-success', text: 'text-foreground' },
  warn: { surface: 'border-warning/40 bg-warning/10', dot: 'bg-warning', text: 'text-foreground' },
  error: { surface: 'border-destructive/40 bg-destructive/10', dot: 'bg-destructive', text: 'text-foreground' },
  info: { surface: 'border-info/30 bg-info/10', dot: 'bg-info', text: 'text-foreground' },
  idle: { surface: 'border-border/60 bg-muted/40', dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  busy: { surface: 'border-border/60 bg-muted/40', dot: '', text: 'text-foreground' },
}

const SIZE = {
  sm: { box: 'h-6 gap-1.5 px-2 text-xs', dot: 'h-1.5 w-1.5', spinner: 'h-3 w-3' },
  md: { box: 'h-7 gap-2 px-2.5 text-xs sm:text-sm', dot: 'h-2 w-2', spinner: 'h-3.5 w-3.5' },
} as const

/**
 * One live state: a dot (or a spinner while busy), the state word and an
 * optional reason. The label is a direct text child of the pill, next to
 * the dot, so `getByText(label)` finds the pill itself.
 */
export function StatusPill({ tone, label, detail, pulse, size = 'md', to, title, className, ...rest }: StatusPillProps) {
  const t = TONE[tone]
  const s = SIZE[size]
  const classes = cn(
    'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-medium leading-none',
    s.box,
    t.surface,
    t.text,
    to && 'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    className,
  )
  const content = (
    <>
      {tone === 'busy' ? (
        <Loader2 className={cn('shrink-0 animate-spin text-muted-foreground', s.spinner)} aria-hidden="true" />
      ) : (
        <span className={cn('shrink-0 rounded-full', s.dot, t.dot, pulse && 'motion-safe:animate-pulse')} aria-hidden="true" />
      )}
      {label}
      {detail && <span className="font-normal text-muted-foreground"> — {detail}</span>}
    </>
  )

  if (to) {
    return (
      <Link to={to} title={title} className={classes} {...(rest as Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>)}>
        {content}
      </Link>
    )
  }
  return (
    <span title={title} className={classes} {...rest}>
      {content}
    </span>
  )
}
