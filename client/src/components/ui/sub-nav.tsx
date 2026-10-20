import { Fragment, useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { DisabledReason } from '@/components/DisabledReason'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface SubNavItem {
  id: string
  label: string
  icon?: LucideIcon
  /** A count or small marker at the row's end. */
  badge?: ReactNode
  tone?: 'default' | 'warning' | 'danger'
  /** Marks a section with unsaved edits. */
  dirty?: boolean
  disabled?: boolean
  disabledReason?: string
}

export interface SubNavGroup {
  id: string
  label?: string
  items: SubNavItem[]
}

export interface SubNavProps {
  /**
   * 'tabs': Radix tab triggers (role="tab"); must sit inside the page's own
   * `<Tabs value onValueChange orientation="vertical">` so its TabsContent
   * panels link up. 'nav': buttons with aria-current, for views the page
   * swaps itself.
   */
  kind: 'tabs' | 'nav'
  groups: SubNavGroup[]
  value: string
  onValueChange: (id: string) => void
  ariaLabel: string
  /** Below lg: a full-width select (default) or a horizontal chip strip (5 items or fewer). */
  mobile?: 'select' | 'scroll'
  /** Under the rail: a link out ("Open in Diagnostics"). */
  footer?: ReactNode
  className?: string
}

const TONE_ICON = {
  default: '',
  warning: 'text-warning',
  danger: 'text-destructive',
} as const

/**
 * A page's own sections: a 15rem rail from lg up, a select (or a chip strip)
 * below. The active row looks like the main sidebar's: a tint, medium
 * weight and a 2px start bar. Its style comes from `value`, never from
 * Radix's data-state, which a wrapping Tooltip can overwrite.
 */
export function SubNav({ kind, groups, value, onValueChange, ariaLabel, mobile = 'select', footer, className }: SubNavProps) {
  const { t } = useTranslation('shell')
  const baseId = useId()
  const scroll = mobile === 'scroll'

  const itemClass = (active: boolean) =>
    cn(
      'group relative flex min-h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-start text-sm transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50 lg:w-full',
      active ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
    )

  const itemContent = (item: SubNavItem, active: boolean) => {
    const Icon = item.icon
    return (
      <>
        {active && (
          <span className="absolute start-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" aria-hidden="true" />
        )}
        {Icon && (
          <Icon
            className={cn('h-4 w-4 shrink-0', TONE_ICON[item.tone ?? 'default'] || (active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'))}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate">{item.label}</span>
        {item.dirty && (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
            {/* &nbsp;: a plain leading space is dropped from the tab's accessible name. */}
            <span className="sr-only">&nbsp;({t('subNav.unsaved')})</span>
          </>
        )}
        {item.badge !== undefined && item.badge !== null && <span className="ms-auto shrink-0">{item.badge}</span>}
      </>
    )
  }

  // Its own provider, so a page (or its test) needs none for the reason tooltip.
  const withReason = (item: SubNavItem, node: ReactNode) =>
    item.disabled && item.disabledReason ? (
      <TooltipProvider key={item.id} delayDuration={150}>
        <DisabledReason reason={item.disabledReason} side="right" className="lg:w-full">
          {node as React.ReactElement}
        </DisabledReason>
      </TooltipProvider>
    ) : (
      node
    )

  const listLayout = cn(
    scroll ? 'flex gap-1 overflow-x-auto pb-1 lg:pb-0' : 'hidden lg:flex',
    'lg:flex-col lg:gap-px lg:overflow-visible',
  )
  const groupLabel = (group: SubNavGroup, labelId?: string) =>
    group.label ? (
      <p id={labelId} role="presentation" className={cn('label-micro hidden px-2.5 pb-1.5 lg:block', kind === 'tabs' && 'pt-4 first:pt-0')}>
        {group.label}
      </p>
    ) : null

  const rail =
    kind === 'tabs' ? (
      <TabsPrimitive.List aria-label={ariaLabel} className={listLayout}>
        {groups.map((group) => (
          <Fragment key={group.id}>
            {groupLabel(group)}
            {group.items.map((item) => {
              const active = item.id === value
              return (
                <Fragment key={item.id}>
                  {withReason(
                    item,
                    <TabsPrimitive.Trigger value={item.id} disabled={item.disabled} className={itemClass(active)}>
                      {itemContent(item, active)}
                    </TabsPrimitive.Trigger>,
                  )}
                </Fragment>
              )
            })}
          </Fragment>
        ))}
      </TabsPrimitive.List>
    ) : (
      <nav aria-label={ariaLabel} className={listLayout}>
        {groups.map((group) => {
          const labelId = group.label ? `${baseId}-${group.id}` : undefined
          return (
            <div
              key={group.id}
              role={group.label ? 'group' : undefined}
              aria-labelledby={labelId}
              className="flex shrink-0 gap-1 lg:mt-4 lg:flex-col lg:gap-px lg:first:mt-0"
            >
              {groupLabel(group, labelId)}
              {group.items.map((item) => {
                const active = item.id === value
                return (
                  <Fragment key={item.id}>
                    {withReason(
                      item,
                      <button
                        type="button"
                        disabled={item.disabled}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => onValueChange(item.id)}
                        className={itemClass(active)}
                      >
                        {itemContent(item, active)}
                      </button>,
                    )}
                  </Fragment>
                )
              })}
            </div>
          )
        })}
      </nav>
    )

  return (
    <div className={cn('min-w-0', className)}>
      {!scroll && (
        <div className="relative lg:hidden">
          <select
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            className="h-11 w-full appearance-none rounded-md border border-input bg-input pe-9 ps-3 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-10 md:text-sm"
          >
            {groups.map((group) => {
              const options = group.items.map((item) => (
                <option key={item.id} value={item.id} disabled={item.disabled}>
                  {item.dirty ? `${item.label} (${t('subNav.unsaved')})` : item.label}
                </option>
              ))
              return group.label ? (
                <optgroup key={group.id} label={group.label}>
                  {options}
                </optgroup>
              ) : (
                <Fragment key={group.id}>{options}</Fragment>
              )
            })}
          </select>
          <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        </div>
      )}
      {rail}
      {footer && <div className="mt-3 border-t border-border/50 pt-3">{footer}</div>}
    </div>
  )
}

export interface SubNavLayoutProps {
  nav: ReactNode
  children: ReactNode
  className?: string
}

/** The rail and the content: a 15rem sticky column from lg up, stacked below. */
export function SubNavLayout({ nav, children, className }: SubNavLayoutProps) {
  return (
    <div className={cn('lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-6', className)}>
      <div className="nav-scroll mb-4 lg:sticky lg:top-4 lg:-mx-1 lg:mb-0 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:px-1 lg:py-px">
        {nav}
      </div>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  )
}
