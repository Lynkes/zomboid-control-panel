import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle,
  File as FileIcon,
  FileQuestion,
  FileText,
  Folder,
  Link2,
  Link2Off,
  Lock,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatBytes } from '@/lib/formatBytes'
import { parentPath } from '@/lib/filesApi'
import { cn } from '@/lib/utils'
import type { FileEntry, ProtectedArea, RootDescriptor } from '@/types/files'
import { FileRowMenu, type RowAction } from './FileRowMenu'
import {
  canMutateEntry,
  canReadEntry,
  canSelectEntry,
  escapesRoot,
  formatFileDate,
  isBrokenLink,
  isFolderLike,
  openModeFor,
} from './filesUi'

const DESKTOP_ROW_HEIGHT = 40
const MOBILE_ROW_HEIGHT = 60

const DESKTOP_GRID = 'grid-cols-[2.5rem_1.75rem_minmax(0,1fr)_5.5rem_10.5rem_2.5rem_2.75rem]'
const MOBILE_GRID = 'grid-cols-[2.75rem_1.75rem_minmax(0,1fr)_auto_2.75rem]'

// The box stays checkbox-sized (the app's coarse-pointer rule would stretch
// any button to 44px); the label around it is the 44px touch target.
const CHECKBOX_BOX = 'h-5 w-5 !min-h-0 !min-w-0 sm:h-4 sm:w-4'
const CHECKBOX_HIT_AREA = 'flex h-11 w-11 cursor-pointer items-center justify-center sm:h-8 sm:w-8'

function protectionLink(area: ProtectedArea): { to: string; labelKey: string } | null {
  if (area === 'panelBackups') return { to: '/backups', labelKey: 'protected.openBackups' }
  if (area === 'bridgeIo' || area === 'bridgeManaged') return { to: '/settings?tab=bridge', labelKey: 'protected.openBridgeSettings' }
  return null
}

/** The lock badge on a protected row: why it's protected, and where to go instead. */
function ProtectedBadge({ area }: { area: ProtectedArea }) {
  const { t } = useTranslation('files')
  const link = protectionLink(area)
  const explanation = t(`protected.areas.${area}`)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7 sm:min-w-7"
        aria-label={`${t('protected.badge')}: ${explanation}`}
      >
        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-xs">
        <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('protected.badge')}
        </DropdownMenuLabel>
        <p className="px-2 pb-2 text-sm leading-relaxed text-foreground">{explanation}</p>
        {link && (
          <DropdownMenuItem asChild className="min-h-11 sm:min-h-0">
            <Link to={link.to}>{t(link.labelKey)}</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  const className = 'h-4 w-4 shrink-0'
  if (entry.protection?.level === 'sealed') return <Lock className={cn(className, 'text-muted-foreground')} aria-hidden="true" />
  if (entry.type === 'link') {
    if (escapesRoot(entry) || isBrokenLink(entry)) return <Link2Off className={cn(className, 'text-muted-foreground')} aria-hidden="true" />
    return <Link2 className={cn(className, 'text-primary')} aria-hidden="true" />
  }
  if (entry.type === 'dir') return <Folder className={cn(className, 'text-primary')} aria-hidden="true" />
  if (entry.type === 'other') return <FileQuestion className={cn(className, 'text-muted-foreground')} aria-hidden="true" />
  if (entry.flags.editable) return <FileText className={cn(className, 'text-muted-foreground')} aria-hidden="true" />
  return <FileIcon className={cn(className, 'text-muted-foreground')} aria-hidden="true" />
}

/** Why an entry that can't be opened does nothing when clicked. */
function blockedReason(entry: FileEntry, t: (key: string) => string): string | null {
  if (entry.flags.unsupportedName) return t('list.unsupportedName')
  if (escapesRoot(entry)) return t('list.linkOutside')
  if (isBrokenLink(entry)) return t('list.linkBroken')
  if (entry.protection) return t(`protected.areas.${entry.protection.area}`)
  return null
}

interface FileListProps {
  entries: FileEntry[]
  root: RootDescriptor
  selected: ReadonlySet<string>
  isDesktop: boolean
  /** Search results: show each entry's folder under its name. */
  showFolder?: boolean
  ariaLabel: string
  onToggleSelect: (entry: FileEntry) => void
  onSelectAll: (select: boolean) => void
  onOpen: (entry: FileEntry) => void
  onAction: (action: RowAction, entry: FileEntry) => void
  onParent: () => void
  onDeleteKey: (permanent: boolean, active: FileEntry | null) => void
}

// The file table (spec §A14.2): virtualized with @tanstack/react-virtual so a
// 200,000-name folder renders the same as a 20-name one, exposed as an ARIA
// table (aria-rowcount/aria-rowindex count every row, not only the rendered
// ones). Keyboard: arrows move between rows, Enter opens, Backspace or
// Alt+Up goes up a folder, Delete moves to Trash (Shift+Delete: permanently),
// F2 renames, Ctrl/Cmd+A selects everything, Esc clears the selection.
export function FileList({
  entries,
  root,
  selected,
  isDesktop,
  showFolder = false,
  ariaLabel,
  onToggleSelect,
  onSelectAll,
  onOpen,
  onAction,
  onParent,
  onDeleteKey,
}: FileListProps) {
  const { t, i18n } = useTranslation('files')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const pendingFocusRef = useRef<number | null>(null)
  const rowHeight = isDesktop ? DESKTOP_ROW_HEIGHT : MOBILE_ROW_HEIGHT

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  useEffect(() => {
    if (activeIndex >= entries.length) setActiveIndex(Math.max(0, entries.length - 1))
  }, [activeIndex, entries.length])

  // After an arrow key scrolls a row into range, move focus onto it once it
  // has rendered.
  useEffect(() => {
    const index = pendingFocusRef.current
    if (index === null) return
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"] [data-row-primary]`)
    if (row) {
      pendingFocusRef.current = null
      row.focus()
    }
  })

  const selectableCount = entries.filter(canSelectEntry).length
  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length
  const allSelected = selectableCount > 0 && selectedCount === selectableCount

  const moveActive = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(entries.length - 1, next))
    setActiveIndex(clamped)
    pendingFocusRef.current = clamped
    virtualizer.scrollToIndex(clamped, { align: 'auto' })
  }, [entries.length, virtualizer])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    // A menu or popup inside a row handles its own keys.
    if (target.closest('[role="menu"]')) return
    // A menu button (the row's "..." or lock badge) opens on Enter, Space
    // and the arrows itself.
    if (target.closest('[aria-haspopup]') && (event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ')) return
    const active = entries[activeIndex] ?? null
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(activeIndex + 1)
    } else if (event.key === 'ArrowUp' && event.altKey) {
      event.preventDefault()
      onParent()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(activeIndex - 1)
    } else if (event.key === 'Home' && !mod) {
      event.preventDefault()
      moveActive(0)
    } else if (event.key === 'End' && !mod) {
      event.preventDefault()
      moveActive(entries.length - 1)
    } else if (event.key === 'Backspace') {
      event.preventDefault()
      onParent()
    } else if (event.key === 'Enter') {
      // The name button opens on its own click; don't open twice.
      if (target.closest('[data-row-primary]')) return
      if (active && openModeFor(active) !== 'blocked') {
        event.preventDefault()
        onOpen(active)
      }
    } else if (event.key === 'Delete') {
      event.preventDefault()
      onDeleteKey(event.shiftKey, active)
    } else if (event.key === 'F2') {
      event.preventDefault()
      if (active && canMutateEntry(active, root)) onAction('rename', active)
    } else if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      onSelectAll(true)
    } else if (event.key === 'Escape' && selectedCount > 0) {
      event.preventDefault()
      onSelectAll(false)
    }
  }

  const grid = isDesktop ? DESKTOP_GRID : MOBILE_GRID

  return (
    <div
      role="table"
      aria-label={ariaLabel}
      aria-rowcount={entries.length + 1}
      className="group rounded-lg border border-border/60"
      onKeyDown={handleKeyDown}
    >
      <div role="rowgroup" className="border-b border-border/60 bg-muted/30">
        <div role="row" aria-rowindex={1} className={cn('grid items-center gap-1 px-1 text-xs font-medium text-muted-foreground', grid, isDesktop ? 'h-9' : 'h-11')}>
          <div role="columnheader" className="flex justify-center">
            <label className={CHECKBOX_HIT_AREA}>
              <Checkbox
                // Checked only when everything is: the shared Checkbox draws its
                // tick for 'indeterminate' too, which would read as "all selected".
                checked={allSelected}
                onCheckedChange={(value) => onSelectAll(value === true)}
                disabled={selectableCount === 0}
                aria-label={t('list.selectAll')}
                className={CHECKBOX_BOX}
              />
            </label>
          </div>
          <div role="columnheader" aria-hidden="true" />
          <div role="columnheader">{t('list.columns.name')}</div>
          {isDesktop ? (
            <>
              <div role="columnheader" className="pe-3 text-end">{t('list.columns.size')}</div>
              <div role="columnheader" className="ps-1">{t('list.columns.modified')}</div>
              <div role="columnheader" aria-hidden="true" />
            </>
          ) : (
            <div role="columnheader" aria-hidden="true" />
          )}
          <div role="columnheader"><span className="sr-only">{t('list.columns.actions')}</span></div>
        </div>
      </div>
      <div ref={scrollRef} className="max-h-[calc(100dvh-22rem)] min-h-[8rem] overflow-auto md:max-h-[calc(100dvh-20rem)]">
        <div role="rowgroup" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = entries[virtualRow.index]
            const openMode = openModeFor(entry)
            const canMutate = canMutateEntry(entry, root)
            const canRead = canReadEntry(entry)
            const selectable = canSelectEntry(entry)
            const isSelected = selected.has(entry.path)
            const reason = openMode === 'blocked' ? blockedReason(entry, t) : null
            const sizeText = isFolderLike(entry) || entry.size === null ? '' : formatBytes(entry.size, i18n.language)
            const dateText = formatFileDate(entry.modifiedAt, i18n.language)
            const folder = showFolder ? parentPath(entry.path) : ''
            const nameContent = (
              <>
                <bdi dir="ltr" className="block truncate">{entry.name}</bdi>
                {showFolder && folder && (
                  <bdi dir="ltr" className="block truncate font-mono text-[11px] text-muted-foreground">{folder}</bdi>
                )}
                {!isDesktop && (sizeText || dateText) && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {[sizeText, dateText].filter(Boolean).join(' · ')}
                  </span>
                )}
              </>
            )
            return (
              <div
                key={entry.path}
                role="row"
                aria-rowindex={virtualRow.index + 2}
                data-row-index={virtualRow.index}
                data-active={virtualRow.index === activeIndex ? 'true' : undefined}
                onFocusCapture={() => setActiveIndex(virtualRow.index)}
                className={cn(
                  'absolute inset-x-0 grid items-center gap-1 border-b border-border/30 px-1 text-sm',
                  grid,
                  isSelected ? 'bg-primary/10' : 'hover:bg-muted/40',
                  'group-focus-within:data-[active=true]:ring-1 group-focus-within:data-[active=true]:ring-inset group-focus-within:data-[active=true]:ring-primary/40',
                )}
                style={{ top: 0, height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
              >
                <div role="cell" className="flex justify-center">
                  <label className={CHECKBOX_HIT_AREA}>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => { if (selectable) onToggleSelect(entry) }}
                      disabled={!selectable}
                      aria-label={t('list.selectItem', { name: entry.name })}
                      className={CHECKBOX_BOX}
                    />
                  </label>
                </div>
                <div role="cell" className="flex justify-center">
                  <EntryIcon entry={entry} />
                </div>
                <div role="cell" className="min-w-0">
                  {reason === null ? (
                    <button
                      type="button"
                      data-row-primary=""
                      onClick={() => onOpen(entry)}
                      className="block min-h-11 w-full min-w-0 rounded px-1 text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                    >
                      {nameContent}
                    </button>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-row-primary=""
                          aria-disabled="true"
                          className="block min-h-11 w-full min-w-0 cursor-default rounded px-1 text-start text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                        >
                          {nameContent}
                          <span className="sr-only">{reason}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">{reason}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                {isDesktop && (
                  <>
                    <div role="cell" className="truncate pe-3 text-end tabular-nums text-muted-foreground">{sizeText}</div>
                    <div role="cell" className="truncate ps-1 text-muted-foreground">{dateText}</div>
                  </>
                )}
                <div role="cell" className="flex justify-center">
                  {entry.protection ? (
                    <ProtectedBadge area={entry.protection.area} />
                  ) : entry.flags.unsupportedName ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                  ) : null}
                </div>
                <div role="cell" className="flex justify-center">
                  <FileRowMenu entry={entry} openMode={openMode} canMutate={canMutate} canRead={canRead} onAction={onAction} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
