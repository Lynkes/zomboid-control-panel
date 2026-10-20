import { Fragment, type ReactNode } from 'react'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface RowActionItem {
  label: string
  icon?: LucideIcon
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
  /** Why it is disabled, shown under the label inside the menu. */
  reason?: string
}

export interface RowActionsProps {
  /** The one labelled action that stays visible ("Restore", "Edit"). */
  primary?: ReactNode
  items: RowActionItem[]
  /** Names the "…" button, with the row it belongs to ("Actions for Backup 3"). */
  ariaLabel: string
  className?: string
}

/**
 * A row's actions: an optional visible primary, everything else in a "…"
 * menu. Destructive items always come last, after a separator.
 */
export function RowActions({ primary, items, ariaLabel, className }: RowActionsProps) {
  const regular = items.filter((item) => !item.destructive)
  const destructive = items.filter((item) => item.destructive)
  const groups = [regular, destructive].filter((group) => group.length > 0)

  return (
    <div className={cn('flex shrink-0 items-center gap-1', className)}>
      {primary}
      {groups.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconDense" aria-label={ariaLabel} title={ariaLabel}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[12rem]">
            {groups.map((group, index) => (
              <Fragment key={index}>
                {index > 0 && <DropdownMenuSeparator />}
                {group.map((item) => {
                  const Icon = item.icon
                  return (
                    <DropdownMenuItem
                      key={item.label}
                      disabled={item.disabled}
                      onSelect={item.onSelect}
                      className={cn(
                        'items-start',
                        item.destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive',
                        // Keep the reason readable: dim the label, not the whole row.
                        item.disabled && 'data-[disabled]:opacity-100',
                      )}
                    >
                      {Icon && <Icon className={cn('mt-0.5', item.disabled && 'opacity-50')} aria-hidden="true" />}
                      <span className="flex min-w-0 flex-col">
                        <span className={cn(item.disabled && 'opacity-50')}>{item.label}</span>
                        {item.disabled && item.reason && (
                          <span className="text-xs font-normal text-muted-foreground">{item.reason}</span>
                        )}
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
