import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronRight, ChevronUp, GripVertical, Info, Merge, ShieldAlert } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'
import { DisabledReason } from '@/components/DisabledReason'
import type { ModGroup, ModInsight, ModNote } from '@/lib/api'
import { loadOrderMoveTarget, moveLoadOrderEntry, type LoadOrderMove } from '@/lib/modLoadOrder'
import {
  gatherGroup,
  groupDotClass,
  isContiguous,
  memberPositions,
  moveGroupBlock,
  moveGroupBlockTo,
  type BlockMove,
  type GroupConflictSummary,
} from '@/lib/modGroupTools'
import { useLocalStorageState } from '@/lib/modsShared'
import { cn } from '@/lib/utils'
import { GroupDot, GroupDots, NoteIndicator } from './GroupDots'
import { KindChip } from './KindChip'
import { LoadOrderMoveControls, type LoadOrderMoveSource } from './LoadOrderMoveControls'

/** Above this many rows the list renders only what is on screen. */
export const VIRTUALIZE_AT = 150

const BLOCK_CONTROL_CLASS =
  'grid h-11 w-11 place-items-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:opacity-30 sm:h-8 sm:w-8'

export interface LoadOrderListProps {
  order: string[]
  onOrderChange: (next: string[]) => void
  /** mods.manage: without it there are no move controls, no drag and no checkboxes. */
  canManage: boolean
  /** Save Order in flight, or an Auto-sort proposal open: nothing moves. */
  locked: boolean
  /** The shared mod filter; rows not matching it are hidden and drag is off. */
  filter: string
  modNames: ReadonlyMap<string, string>
  /** Mod ID to its Workshop item, for notes. */
  modWorkshop: ReadonlyMap<string, string>
  notes: Readonly<Record<string, ModNote>>
  groups: readonly ModGroup[]
  membership: ReadonlyMap<string, readonly ModGroup[]>
  conflictsByGroup?: ReadonlyMap<string, GroupConflictSummary>
  onShowGroupConflicts?: (group: ModGroup, summary: GroupConflictSummary) => void
  /** Shows each group as a block with a header and block move controls. */
  showGroups: boolean
  selected: ReadonlySet<string>
  onSelectedChange: (modId: string, checked: boolean) => void
  onOpenNote?: (workshopId: string, label: string) => void
  /** Smart sort: what the panel makes of a mod (its kind chip). */
  insightOf?: (modId: string) => ModInsight | undefined
  /** Mods the plan of the order on screen would move (their info button is tinted). */
  movingIds?: ReadonlySet<string>
  /** "Why is it here?" for a row; `button` is what was pressed (focus returns to it). */
  onExplain?: (modId: string, button: HTMLElement) => void
  /** The row's "…" menu items (Why is it here?, Always load after/before…). */
  rowMenu?: (modId: string) => RowActionItem[]
}

type Row =
  | { kind: 'header'; group: ModGroup; start: number; end: number; contiguous: boolean; collapsed: boolean; present: number }
  | { kind: 'mod'; index: number; modId: string; key: string; marker: ModGroup | null }

interface LastMove {
  order: string[]
  index: number
  announcement: string
}

/**
 * The Load order list: drag, the per-row move controls, ticks for "Create
 * group from selection", and (with "Show groups") each group as a block with a
 * header that moves the whole group. Moves only change `order`; the page's
 * Save Order writes it. Rows are keyed by mod ID (plus which repeat of it this
 * is), so a reorder moves DOM nodes instead of remounting them.
 */
export function LoadOrderList({
  order,
  onOrderChange,
  canManage,
  locked,
  filter,
  modNames,
  modWorkshop,
  notes,
  groups,
  membership,
  conflictsByGroup,
  onShowGroupConflicts,
  showGroups,
  selected,
  onSelectedChange,
  onOpenNote,
  insightOf,
  movingIds,
  onExplain,
  rowMenu,
}: LoadOrderListProps) {
  const { t } = useTranslation('mods')
  const listRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // A dragged row (its index) or a dragged group block (its id).
  const [dragged, setDragged] = useState<{ kind: 'row'; index: number } | { kind: 'block'; groupId: string } | null>(null)
  const [lastMove, setLastMove] = useState<LastMove | null>(null)
  const [collapsed, setCollapsed] = useLocalStorageState<string[]>('zcp:mods:order:collapsedBlocks', [])
  const pendingFocusRef = useRef<{ index: number; move: LoadOrderMove; source: LoadOrderMoveSource; block?: string } | null>(null)

  const q = filter.trim().toLowerCase()
  const canReorder = canManage && !locked
  const canDrag = canReorder && !q

  // A lock (a save, an Auto-sort proposal) ends any drag in progress: a
  // dragend the page never saw must not steer a later dragover.
  useEffect(() => {
    if (locked) setDragged(null)
  }, [locked])

  const lastMoveOnScreen = lastMove?.order === order ? lastMove : null

  // ── Rows (with group blocks) ───────────────────────────────────────────────
  const blocks = useMemo(() => {
    if (!showGroups) return [] as Array<{ group: ModGroup; positions: number[]; contiguous: boolean }>
    const claimed = new Uint8Array(order.length)
    const result: Array<{ group: ModGroup; positions: number[]; contiguous: boolean }> = []
    for (const group of groups) {
      const positions = memberPositions(order, group.modIds)
      if (positions.length < 2) continue
      const contiguous = isContiguous(positions)
      // One header per row range: a group whose run overlaps a block already
      // shown keeps its colour markers but gets no second header.
      if (positions.some((p) => claimed[p])) continue
      if (contiguous || group.keepTogether) {
        for (const p of positions) claimed[p] = 1
        result.push({ group, positions, contiguous })
      }
    }
    return result
  }, [showGroups, groups, order])

  const blockAt = useMemo(() => {
    const map = new Map<number, { group: ModGroup; positions: number[]; contiguous: boolean }>()
    for (const block of blocks) for (const p of block.positions) map.set(p, block)
    return map
  }, [blocks])

  const rows = useMemo<Row[]>(() => {
    const repeats = new Map<string, number>()
    const collapsedSet = new Set(collapsed)
    const result: Row[] = []
    order.forEach((modId, index) => {
      const repeat = repeats.get(modId) ?? 0
      repeats.set(modId, repeat + 1)
      if (q) {
        const name = modNames.get(modId)
        if (!modId.toLowerCase().includes(q) && !(name && name.toLowerCase().includes(q))) return
      }
      const block = blockAt.get(index)
      if (block && !q && block.positions[0] === index) {
        result.push({
          kind: 'header',
          group: block.group,
          start: block.positions[0],
          end: block.positions[block.positions.length - 1],
          contiguous: block.contiguous,
          collapsed: block.contiguous && collapsedSet.has(block.group.id),
          present: block.positions.length,
        })
      }
      if (block && !q && block.contiguous && collapsedSet.has(block.group.id)) return
      const marker = showGroups ? (block?.group ?? membership.get(modId)?.[0] ?? null) : null
      result.push({ kind: 'mod', index, modId, key: `${modId}#${repeat}`, marker })
    })
    return result
  }, [order, q, modNames, blockAt, collapsed, showGroups, membership])

  const virtualize = rows.length > VIRTUALIZE_AT
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? 44 : 38),
    overscan: 12,
    getItemKey: (i) => (rows[i]?.kind === 'header' ? `h:${(rows[i] as { group: ModGroup }).group.id}` : (rows[i] as { key: string })?.key ?? i),
  })

  // ── Moves ──────────────────────────────────────────────────────────────────
  const moveRow = useCallback((index: number, move: LoadOrderMove, source: LoadOrderMoveSource) => {
    if (!canReorder) return
    const to = loadOrderMoveTarget(index, order.length, move)
    if (to === null) return
    const next = moveLoadOrderEntry(order, index, to)
    setDragged(null)
    setLastMove({
      order: next,
      index: to,
      announcement: t('loadOrder.movedAnnouncement', { name: order[index], position: to + 1, total: next.length }),
    })
    pendingFocusRef.current = { index: to, move, source }
    onOrderChange(next)
  }, [canReorder, order, onOrderChange, t])

  // A neighbouring shown block is one unit: Up/Down jump over it whole.
  const unitAt = useCallback((index: number) => {
    const block = blockAt.get(index)
    return block && block.contiguous ? ([block.positions[0], block.positions[block.positions.length - 1]] as const) : null
  }, [blockAt])

  const moveBlock = (group: ModGroup, move: BlockMove, source: LoadOrderMoveSource) => {
    if (!canReorder) return
    const next = moveGroupBlock(order, group.modIds, move, unitAt)
    if (!next) return
    const start = memberPositions(next, group.modIds)[0]
    setDragged(null)
    setLastMove({
      order: next,
      index: start,
      announcement: t('loadOrder.blockMovedAnnouncement', { name: group.name, position: start + 1, total: next.length }),
    })
    pendingFocusRef.current = { index: start, move, source, block: group.id }
    onOrderChange(next)
  }

  const gather = (group: ModGroup) => {
    if (!canReorder) return
    const next = gatherGroup(order, group.modIds)
    setLastMove({
      order: next,
      index: memberPositions(next, group.modIds)[0],
      announcement: t('loadOrder.gatheredAnnouncement', { name: group.name }),
    })
    onOrderChange(next)
  }

  const toggleCollapsed = (groupId: string) => {
    setCollapsed((current) => (current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]))
  }

  // Runs after the reordered list has rendered: bring the moved row (or block
  // header) into view and put focus back on the pressed control. A control
  // that reached the first or last slot is disabled now; from the keyboard
  // focus goes to its DisabledReason wrapper (Enter there does nothing and its
  // tooltip says why), from a mouse to the row itself.
  useEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    pendingFocusRef.current = null
    const focusIn = (row: HTMLElement) => {
      row.scrollIntoView({ block: 'nearest' })
      const attr = pending.block ? 'data-block-action' : 'data-move-action'
      const pressed = row.querySelector<HTMLButtonElement>(`button[${attr}="${pending.move}"]`)
      if (pressed && !pressed.disabled) {
        pressed.focus({ preventScroll: true })
        return
      }
      const wrapper = pressed?.parentElement
      const target = pending.source === 'keyboard' && wrapper && wrapper.tabIndex >= 0 ? wrapper : row
      target.focus({ preventScroll: true })
    }
    const selector = pending.block ? `[data-block-header="${pending.block}"]` : `[data-load-order-index="${pending.index}"]`
    const row = listRef.current?.querySelector<HTMLElement>(selector)
    if (row) {
      focusIn(row)
      return
    }
    if (!virtualize) return
    // Off screen in a long list: scroll it in, then focus once it is rendered.
    const rowIndex = rows.findIndex((r) => (pending.block ? r.kind === 'header' && r.group.id === pending.block : r.kind === 'mod' && r.index === pending.index))
    if (rowIndex < 0) return
    virtualizer.scrollToIndex(rowIndex, { align: 'center' })
    let tries = 0
    const retry = () => {
      const found = listRef.current?.querySelector<HTMLElement>(selector)
      if (found) focusIn(found)
      else if (++tries < 10) requestAnimationFrame(retry)
    }
    requestAnimationFrame(retry)
  }, [order, rows, virtualize, virtualizer])

  // ── Drag ───────────────────────────────────────────────────────────────────
  // Over a row: a dragged row takes its slot; a dragged block lands next to it.
  // Over a block header (`header`): both land just before that block, never
  // inside it.
  const handleDragOver = (event: DragEvent, index: number, header = false) => {
    event.preventDefault()
    if (!canDrag || !dragged) return
    if (dragged.kind === 'row') {
      if (dragged.index < 0 || dragged.index >= order.length) return
      const to = header && dragged.index < index ? index - 1 : index
      if (dragged.index === to) return
      const next = moveLoadOrderEntry(order, dragged.index, to)
      onOrderChange(next)
      setDragged({ kind: 'row', index: to })
      return
    }
    const group = groups.find((g) => g.id === dragged.groupId)
    if (!group) return
    const positions = memberPositions(order, group.modIds)
    const start = positions[0]
    const end = positions[positions.length - 1]
    if (!isContiguous(positions) || (index >= start && index <= end)) return
    const target = index < start ? index : header ? index - positions.length : index - positions.length + 1
    const next = moveGroupBlockTo(order, group.modIds, target)
    if (next) onOrderChange(next)
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  const renderHeader = (row: Extract<Row, { kind: 'header' }>) => {
    const { group } = row
    const summary = conflictsByGroup?.get(group.id)
    const atTop = row.start === 0
    const atBottom = row.end === order.length - 1
    const blockControls: Array<{ move: BlockMove; Icon: typeof ChevronUp; label: string; edge: boolean }> = [
      { move: 'top', Icon: ArrowUpToLine, label: t('loadOrder.blockToTopAria', { name: group.name }), edge: atTop },
      { move: 'up', Icon: ChevronUp, label: t('loadOrder.blockUpAria', { name: group.name }), edge: atTop },
      { move: 'down', Icon: ChevronDown, label: t('loadOrder.blockDownAria', { name: group.name }), edge: atBottom },
      { move: 'bottom', Icon: ArrowDownToLine, label: t('loadOrder.blockToBottomAria', { name: group.name }), edge: atBottom },
    ]
    return (
      <div
        data-block-header={group.id}
        tabIndex={-1}
        draggable={canDrag && row.contiguous}
        onDragStart={(event) => {
          if (!canDrag || !row.contiguous) return
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
          setDragged({ kind: 'block', groupId: group.id })
        }}
        onDragOver={(event) => handleDragOver(event, row.start, true)}
        onDragEnd={() => setDragged(null)}
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 bg-muted/60 px-2 py-1 outline-none',
          canDrag && row.contiguous && 'cursor-move',
          dragged?.kind === 'block' && dragged.groupId === group.id && 'opacity-50',
        )}
      >
        <GripVertical className={cn('h-3 w-3 shrink-0 text-muted-foreground/40', !(canDrag && row.contiguous) && 'invisible')} aria-hidden="true" />
        <button
          type="button"
          onClick={() => toggleCollapsed(group.id)}
          disabled={!row.contiguous}
          aria-expanded={!row.collapsed}
          aria-label={row.collapsed ? t('loadOrder.expandBlockAria', { name: group.name }) : t('loadOrder.collapseBlockAria', { name: group.name })}
          className="grid h-8 w-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:opacity-40"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform rtl:-scale-x-100', !row.collapsed && 'rotate-90 rtl:-rotate-90')} aria-hidden="true" />
        </button>
        <GroupDot color={group.color} />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{group.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{t('loadOrder.blockCount', { count: row.present })}</span>
        {group.keepTogether && <span className="rounded-full border border-border/70 px-2 text-[11px] text-muted-foreground">{t('loadOrder.blockTogether')}</span>}
        {summary && (
          <button
            type="button"
            onClick={() => onShowGroupConflicts?.(group, summary)}
            disabled={!onShowGroupConflicts}
            className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 text-[11px] font-medium text-foreground hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            aria-label={t('loadOrder.blockConflictsAria', { count: summary.internal + summary.external, name: group.name })}
          >
            <ShieldAlert className="h-3 w-3 text-warning" aria-hidden="true" />
            {summary.internal + summary.external}
          </button>
        )}
        {!row.contiguous && (
          <span className="inline-flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('loadOrder.blockApart')}
          </span>
        )}
        <span className="ms-auto flex shrink-0 items-center">
          {!row.contiguous ? (
            canManage && (
              <button
                type="button"
                onClick={() => gather(group)}
                disabled={!canReorder}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 px-2 text-xs font-medium text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-40"
              >
                <Merge className="h-3.5 w-3.5" aria-hidden="true" />
                {t('loadOrder.gather')}
              </button>
            )
          ) : (
            canManage &&
            blockControls.map(({ move, Icon, label, edge }) => {
              const button = (
                <button
                  key={move}
                  type="button"
                  data-block-action={move}
                  disabled={!canReorder || edge}
                  aria-label={label}
                  // eslint-disable-next-line local/no-dead-disabled-title -- the control's own name as a hover hint; at an edge the DisabledReason wrapper says why, and the list states the lock once above it.
                  title={label}
                  onClick={(event) => {
                    if (event.detail > 1) return
                    moveBlock(group, move, event.detail === 0 ? 'keyboard' : 'pointer')
                  }}
                  className={BLOCK_CONTROL_CLASS}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )
              return edge && canReorder ? (
                <DisabledReason key={move} reason={move === 'top' || move === 'up' ? t('loadOrder.blockAlreadyFirst') : t('loadOrder.blockAlreadyLast')}>
                  {button}
                </DisabledReason>
              ) : (
                button
              )
            })
          )}
        </span>
      </div>
    )
  }

  const renderMod = (row: Extract<Row, { kind: 'mod' }>) => {
    const { index: idx, modId, marker } = row
    const displayName = modNames.get(modId)
    const workshopId = modWorkshop.get(modId)
    const note = workshopId ? notes[workshopId] : undefined
    const justMoved = lastMoveOnScreen?.index === idx
    const draggingThis = dragged?.kind === 'row' && dragged.index === idx
    const groupsOfMod = membership.get(modId) ?? []
    return (
      <LoadOrderRow
        idx={idx}
        modId={modId}
        displayName={displayName}
        total={order.length}
        canManage={canManage}
        canDrag={canDrag}
        locked={!canReorder}
        dragging={draggingThis}
        justMoved={justMoved}
        checked={selected.has(modId)}
        marker={marker}
        groups={groupsOfMod}
        note={note}
        onOpenNote={workshopId && onOpenNote ? () => onOpenNote(workshopId, displayName ?? modId) : undefined}
        insight={insightOf?.(modId)}
        moving={movingIds?.has(modId) ?? false}
        onExplain={onExplain}
        rowMenu={rowMenu}
        onSelectedChange={onSelectedChange}
        onMove={moveRow}
        onDragStart={() => {
          if (!canDrag) return
          setDragged({ kind: 'row', index: idx })
        }}
        onDragOver={(event) => handleDragOver(event, idx)}
        onDragEnd={() => setDragged(null)}
      />
    )
  }

  const renderRow = (row: Row) => (row.kind === 'header' ? renderHeader(row) : renderMod(row))

  return (
    <div>
      <div ref={scrollRef} className="h-[calc(100vh-320px)] min-h-[240px] overflow-y-auto" data-load-order-scroll="">
        {/* onDrop: the drop event bubbles here from a row that is still
            mounted, so it ends a drag even when its dragend is lost;
            preventDefault also stops a file dropped on the list from
            navigating the tab to it. */}
        <div
          ref={listRef}
          className={cn(!virtualize && 'divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70')}
          onDrop={(event) => { event.preventDefault(); setDragged(null) }}
          style={virtualize ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}
        >
          {virtualize
            ? virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className={cn('absolute inset-x-0 top-0 border-b border-border/60', row.kind === 'mod' && row.index % 2 === 1 && 'bg-card/70')}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {renderRow(row)}
                  </div>
                )
              })
            : rows.map((row) => (row.kind === 'header' ? <Fragment key={`h:${row.group.id}`}>{renderHeader(row)}</Fragment> : <Fragment key={row.key}>{renderMod(row)}</Fragment>))}
        </div>
      </div>
      {/* Not gated on unsaved changes: a move that puts the saved order back
          (a nudge undone) is still a move, and must still be announced. */}
      <p className="sr-only" role="status" aria-live="polite">
        {lastMoveOnScreen?.announcement}
      </p>
    </div>
  )
}

interface LoadOrderRowProps {
  idx: number
  modId: string
  displayName: string | undefined
  total: number
  canManage: boolean
  canDrag: boolean
  locked: boolean
  dragging: boolean
  justMoved: boolean
  checked: boolean
  marker: ModGroup | null
  groups: readonly ModGroup[]
  note: ModNote | undefined
  onOpenNote?: () => void
  insight: ModInsight | undefined
  moving: boolean
  onExplain?: (modId: string, button: HTMLElement) => void
  rowMenu?: (modId: string) => RowActionItem[]
  onSelectedChange: (modId: string, checked: boolean) => void
  onMove: (index: number, move: LoadOrderMove, source: LoadOrderMoveSource) => void
  onDragStart: () => void
  onDragOver: (event: DragEvent) => void
  onDragEnd: () => void
}

/** One Load order row. The first `.font-mono` in it is the mod ID. */
const LoadOrderRow = memo(function LoadOrderRow({
  idx,
  modId,
  displayName,
  total,
  canManage,
  canDrag,
  locked,
  dragging,
  justMoved,
  checked,
  marker,
  groups,
  note,
  onOpenNote,
  insight,
  moving,
  onExplain,
  rowMenu,
  onSelectedChange,
  onMove,
  onDragStart,
  onDragOver,
  onDragEnd,
}: LoadOrderRowProps) {
  const { t } = useTranslation('mods')
  const { t: tSmart } = useTranslation('modsSmart')
  const label = displayName ?? modId
  return (
    <div
      data-load-order-index={idx}
      // Focusable from script only: where focus goes after a mouse move
      // reaches the first or last slot. The row's own accent marks it.
      tabIndex={-1}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      // The `!` on the moved and dragged tints: the list stripes even rows
      // with a child selector that a plain bg class on the row loses to.
      className={cn(
        'flex flex-wrap items-center gap-x-2 px-2.5 py-1 outline-none transition-colors duration-150 hover:bg-muted/15 sm:flex-nowrap',
        canDrag && 'cursor-move',
        dragging && 'opacity-30 !bg-primary/5',
        justMoved && '!bg-primary/[0.055] shadow-[inset_2px_0_0_hsl(var(--primary)/0.55)]',
      )}
    >
      {/* Only where the row can actually be dragged; `invisible` keeps its
          column so rows don't shift sideways while the list is locked. */}
      <GripVertical className={cn('h-3 w-3 shrink-0 text-muted-foreground/30', !canDrag && 'invisible')} aria-hidden="true" />
      {marker && <span className={cn('h-4 w-1 shrink-0 rounded-full', groupDotClass(marker.color))} aria-hidden="true" />}
      {canManage && (
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onSelectedChange(modId, value === true)}
          aria-label={t('loadOrder.selectRowAria', { name: displayName ? `${modId} (${displayName})` : modId })}
          className="shrink-0"
        />
      )}
      <span className="w-6 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">{idx + 1}</span>
      {/* Shrinkable (truncates). Below `sm` the four 44px move controls take
          a line of their own, so the mod ID stays readable at phone width. */}
      <span className="min-w-0 truncate font-mono text-[11px]">{modId}</span>
      {displayName ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{displayName}</span> : <span className="flex-1" />}
      <KindChip insight={insight} />
      <GroupDots groups={groups} />
      <NoteIndicator note={note} onOpen={onOpenNote} />
      {onExplain && (
        <button
          type="button"
          data-why-here={modId}
          onClick={(event) => onExplain(modId, event.currentTarget)}
          aria-label={moving ? tSmart('why.buttonAriaMoves', { mod: label }) : tSmart('why.buttonAria', { mod: label })}
          title={moving ? tSmart('why.buttonTitleMoves') : tSmart('why.buttonTitle')}
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
            moving ? 'text-warning hover:text-warning' : 'text-muted-foreground/70 hover:text-foreground',
          )}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      {rowMenu && <RowActions ariaLabel={tSmart('why.rowMenuAria', { mod: label })} items={rowMenu(modId)} />}
      {canManage && (
        <div className="flex w-full justify-end sm:w-auto">
          <LoadOrderMoveControls index={idx} total={total} modId={modId} onMove={onMove} disabled={locked} />
        </div>
      )}
    </div>
  )
})
