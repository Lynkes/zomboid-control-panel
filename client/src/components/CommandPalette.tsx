import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { CornerDownLeft, Keyboard, Search, Server, type LucideIcon } from 'lucide-react'
import { DialogOverlay } from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { useGuardedNavigate } from '@/contexts/UnsavedChangesContext'
import { NAV_SECTIONS, ROUTES, routeAvailability, type RouteMeta } from '@/lib/navigation'
import type { ServerInstance } from '@/lib/api'
import { cn } from '@/lib/utils'

type CommandGroup = 'pages' | 'sections' | 'servers' | 'actions'

interface Command {
  id: string
  group: CommandGroup
  label: string
  /** The page a section belongs to, or the sidebar section of a page. */
  context?: string
  keywords: string
  icon: LucideIcon
  shortcut?: string
  disabledReason?: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null while the server list is still unknown. */
  servers: ServerInstance[] | null
  activeServer: ServerInstance | null
  onSwitchServer: (server: ServerInstance) => void
  onShowShortcuts?: () => void
}

const GROUP_ORDER: CommandGroup[] = ['pages', 'sections', 'servers', 'actions']

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * Ctrl/Cmd+K: jump to any page or page section, or switch the active
 * server, by typing. Pages a role can't use are left out; pages that need a
 * (local) server show the reason instead of opening. Leaving a page with
 * unsaved edits asks first, like the sidebar.
 */
export function CommandPalette({ open, onOpenChange, servers, activeServer, onSwitchServer, onShowShortcuts }: CommandPaletteProps) {
  const { t } = useTranslation('commandPalette')
  const { can } = useAuth()
  const guardedNavigate = useGuardedNavigate()
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const baseId = useId()

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const ctx = { can, serversConfirmedEmpty: servers !== null && servers.length === 0, activeServer }
    const sectionLabel = (route: RouteMeta) => {
      const section = NAV_SECTIONS.find((s) => s.id === route.section)
      return section ? t(section.labelKey) : undefined
    }
    const go = (to: string) => () => {
      onOpenChange(false)
      void guardedNavigate(to)
    }
    const list: Command[] = []
    for (const route of ROUTES) {
      const availability = routeAvailability(route, ctx)
      if (availability.state === 'hidden') continue
      const disabledReason = availability.state === 'disabled' ? t(availability.reasonKey) : undefined
      const title = t(route.titleKey)
      list.push({
        id: `page:${route.path}`,
        group: 'pages',
        label: title,
        context: sectionLabel(route),
        keywords: `${t(route.labelKey)} ${route.path}`,
        icon: route.icon,
        shortcut: route.shortcut,
        disabledReason,
        run: go(route.path),
      })
      for (const item of route.deepLinks?.items ?? []) {
        if (item.capability && !can(item.capability)) continue
        list.push({
          id: `section:${route.path}:${item.id}`,
          group: 'sections',
          label: t(item.labelKey),
          context: title,
          keywords: '',
          icon: route.icon,
          disabledReason,
          run: go(`${route.path}?${route.deepLinks?.param}=${encodeURIComponent(item.id)}`),
        })
      }
    }
    for (const server of servers ?? []) {
      if (server.isActive) continue
      list.push({
        id: `server:${server.id}`,
        group: 'servers',
        label: t('switchServer', { name: server.name }),
        keywords: server.name,
        icon: Server,
        run: () => {
          onOpenChange(false)
          onSwitchServer(server)
        },
      })
    }
    if (onShowShortcuts) {
      list.push({
        id: 'action:shortcuts',
        group: 'actions',
        label: t('showShortcuts'),
        keywords: '?',
        icon: Keyboard,
        shortcut: '?',
        run: () => {
          onOpenChange(false)
          onShowShortcuts()
        },
      })
    }
    return list
  }, [activeServer, can, guardedNavigate, onOpenChange, onShowShortcuts, onSwitchServer, servers, t])

  const results = useMemo(() => {
    const q = normalize(query.trim())
    // Sections only once something is typed: the opening list stays the
    // sidebar's length.
    if (!q) return commands.filter((command) => command.group !== 'sections')
    const tokens = q.split(/\s+/)
    return commands
      .map((command, order) => {
        const label = normalize(command.label)
        const haystack = `${label} ${normalize(command.context ?? '')} ${normalize(command.keywords)}`
        if (!tokens.every((token) => haystack.includes(token))) return null
        const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2
        return { command, score, order }
      })
      .filter((entry): entry is { command: Command; score: number; order: number } => entry !== null)
      .sort((a, b) =>
        GROUP_ORDER.indexOf(a.command.group) - GROUP_ORDER.indexOf(b.command.group) || a.score - b.score || a.order - b.order)
      .map((entry) => entry.command)
  }, [commands, query])

  const enabled = useMemo(() => results.filter((command) => !command.disabledReason), [results])

  // Keep the highlight on a result that is still there; else the first one.
  useEffect(() => {
    setActiveId((current) => (current && enabled.some((c) => c.id === current) ? current : enabled[0]?.id ?? null))
  }, [enabled])
  useEffect(() => {
    setActiveId(enabled[0]?.id ?? null)
    // Only a new query resets the highlight to the top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const optionId = (id: string) => `${baseId}-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  useEffect(() => {
    if (!activeId) return
    const el = listRef.current?.ownerDocument.getElementById(optionId(activeId))
    el?.scrollIntoView?.({ block: 'nearest' })
    // optionId is derived from baseId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (enabled.length === 0) return
      const index = enabled.findIndex((c) => c.id === activeId)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? 0 : (index + step + enabled.length) % enabled.length
      setActiveId(enabled[next].id)
    } else if (event.key === 'Home' && enabled.length > 0 && !query) {
      event.preventDefault()
      setActiveId(enabled[0].id)
    } else if (event.key === 'End' && enabled.length > 0 && !query) {
      event.preventDefault()
      setActiveId(enabled[enabled.length - 1].id)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      enabled.find((c) => c.id === activeId)?.run()
    }
  }

  const grouped = GROUP_ORDER.map((group) => ({ group, items: results.filter((c) => c.group === group) })).filter((g) => g.items.length > 0)
  const listId = `${baseId}-list`

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80dvh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-[0_24px_60px_-20px_hsl(0_0%_0%/0.8)] focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">{t('title')}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t('description')}</DialogPrimitive.Description>
          <div className="flex items-center gap-2 border-b border-border/60 px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId ? optionId(activeId) : undefined}
              aria-label={t('inputLabel')}
              placeholder={t('placeholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              autoComplete="off"
              spellCheck={false}
              // The theme's input fill and focus halo would box a field that
              // always has focus here; the open palette is the focus indicator.
              className="h-12 min-w-0 flex-1 !bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:!shadow-none sm:text-sm"
            />
            <kbd className="hidden shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-micro text-muted-foreground sm:inline-block">Esc</kbd>
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label={t('resultsLabel')} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {grouped.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('noResults', { query: query.trim() })}</p>
            )}
            {grouped.map(({ group, items }) => {
              const headingId = `${baseId}-group-${group}`
              return (
                <div key={group} role="group" aria-labelledby={headingId} className="pb-1">
                  <div id={headingId} role="presentation" className="label-micro px-2 pb-1 pt-2">
                    {t(`groups.${group}`)}
                  </div>
                  {items.map((command) => {
                    const active = command.id === activeId
                    const disabled = !!command.disabledReason
                    const Icon = command.icon
                    return (
                      <div
                        key={command.id}
                        id={optionId(command.id)}
                        role="option"
                        aria-selected={active}
                        aria-disabled={disabled || undefined}
                        onMouseMove={() => { if (!disabled && !active) setActiveId(command.id) }}
                        onClick={() => { if (!disabled) command.run() }}
                        className={cn(
                          'flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm',
                          active ? 'bg-primary/10 text-foreground' : 'text-foreground/90',
                          disabled && 'cursor-not-allowed text-muted-foreground',
                        )}
                      >
                        <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground', disabled && 'opacity-60')} aria-hidden="true" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">
                            {command.group === 'sections' && command.context && (
                              <><span className="text-muted-foreground">{command.context} ›</span>{' '}</>
                            )}
                            {command.label}
                          </span>
                          {disabled && <span className="truncate text-xs text-muted-foreground">{command.disabledReason}</span>}
                        </span>
                        {command.group === 'pages' && command.context && !disabled && (
                          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{command.context}</span>
                        )}
                        {command.shortcut && !disabled && (
                          <kbd className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-micro tabular-nums text-muted-foreground">{command.shortcut}</kbd>
                        )}
                        {active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
          <div className="hidden items-center gap-4 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:flex">
            <span>{t('hints.move')}</span>
            <span>{t('hints.open')}</span>
            <span>{t('hints.close')}</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
