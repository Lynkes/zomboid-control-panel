import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ListOrdered, Loader2, Pencil, Power, PowerOff, ShieldAlert, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'
import type { ModGroup } from '@/lib/api'
import type { GroupConflictSummary } from '@/lib/modGroupTools'
import { useLocalStorageState } from '@/lib/modsShared'
import { cn } from '@/lib/utils'
import { GroupDot } from './GroupDots'
import { VirtualRows } from './VirtualRows'

export interface GroupSectionItem {
  key: string
  /** The mod IDs this row ships: it shows under every group listing one of them. */
  modIds: readonly string[]
}

export interface GroupSectionsProps<T extends GroupSectionItem> {
  items: readonly T[]
  renderItem: (item: T) => ReactNode
  groups: readonly ModGroup[]
  /** Mod IDs in the server's Mods= (for "12 of 14 enabled"). */
  enabledModIds: ReadonlySet<string>
  /** Mod IDs the server's Workshop items ship (members outside it are "not on this server"). */
  availableModIds: ReadonlySet<string>
  modNames: ReadonlyMap<string, string>
  conflictsByGroup?: ReadonlyMap<string, GroupConflictSummary>
  onShowConflicts?: (group: ModGroup, summary: GroupConflictSummary) => void
  canManage: boolean
  /** The group whose Enable / Disable all is in flight. */
  busyGroupId: string | null
  onEnable: (group: ModGroup) => void
  onDisable: (group: ModGroup) => void
  onEdit: (group: ModGroup) => void
  /** "Apply group order" (all groups at once), with why it is off. */
  applyOrder?: { run: () => void; reason: string | null }
  /** While filtering, groups without a matching row are left out. */
  hideEmptyGroups: boolean
  /** Remembers which sections are collapsed. */
  storageKey: string
  className?: string
}

type SectionRow<T> =
  | { kind: 'group'; group: ModGroup; enabled: number; total: number; collapsed: boolean; count: number; missing: string[] }
  | { kind: 'item'; item: T; groupId: string }
  | { kind: 'missing'; groupId: string; ids: string[] }
  | { kind: 'ungrouped'; count: number; collapsed: boolean }

const UNGROUPED = '__ungrouped__'

/**
 * "View: Groups": one collapsible section per mod group (colour, name, "12 of
 * 14 enabled", conflicts), with Enable all / Disable all / Edit / Apply order,
 * then the rows in no group. A row in two groups shows under both. Rows keep
 * every action they have in the plain list.
 */
export function GroupSections<T extends GroupSectionItem>({
  items,
  renderItem,
  groups,
  enabledModIds,
  availableModIds,
  modNames,
  conflictsByGroup,
  onShowConflicts,
  canManage,
  busyGroupId,
  onEnable,
  onDisable,
  onEdit,
  applyOrder,
  hideEmptyGroups,
  storageKey,
  className,
}: GroupSectionsProps<T>) {
  const { t } = useTranslation('modGroups')
  const [collapsed, setCollapsed] = useLocalStorageState<string[]>(storageKey, [])

  const rows = useMemo(() => {
    const collapsedSet = new Set(collapsed)
    const result: Array<SectionRow<T>> = []
    const grouped = new Set<string>()
    for (const group of groups) {
      const rank = new Map(group.modIds.map((id, i) => [id, i]))
      const inGroup = items
        .filter((item) => item.modIds.some((id) => rank.has(id)))
        .sort((a, b) => Math.min(...a.modIds.map((id) => rank.get(id) ?? Infinity)) - Math.min(...b.modIds.map((id) => rank.get(id) ?? Infinity)))
      inGroup.forEach((item) => grouped.add(item.key))
      if (hideEmptyGroups && inGroup.length === 0) continue
      const members = [...new Set(group.modIds)]
      const missing = members.filter((id) => !availableModIds.has(id))
      const isCollapsed = collapsedSet.has(group.id)
      result.push({
        kind: 'group',
        group,
        enabled: members.filter((id) => enabledModIds.has(id)).length,
        total: members.length,
        collapsed: isCollapsed,
        count: inGroup.length,
        missing,
      })
      if (isCollapsed) continue
      for (const item of inGroup) result.push({ kind: 'item', item, groupId: group.id })
      if (missing.length > 0 && !hideEmptyGroups) result.push({ kind: 'missing', groupId: group.id, ids: missing })
    }
    const ungrouped = items.filter((item) => !grouped.has(item.key))
    if (ungrouped.length > 0) {
      const isCollapsed = collapsedSet.has(UNGROUPED)
      result.push({ kind: 'ungrouped', count: ungrouped.length, collapsed: isCollapsed })
      if (!isCollapsed) for (const item of ungrouped) result.push({ kind: 'item', item, groupId: UNGROUPED })
    }
    return result
  }, [collapsed, groups, items, hideEmptyGroups, availableModIds, enabledModIds])

  const toggle = (id: string) =>
    setCollapsed((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))

  const permission = canManage ? null : t('panel.noPermission')

  const renderGroupHeader = (row: Extract<SectionRow<T>, { kind: 'group' }>) => {
    const { group } = row
    const summary = conflictsByGroup?.get(group.id)
    const busy = busyGroupId === group.id
    const canEnableMore = row.total - row.missing.length > row.enabled
    const actions: RowActionItem[] = [
      { label: t('sections.enableAll'), icon: Power, onSelect: () => onEnable(group), disabled: !canManage || busy || !canEnableMore, reason: permission ?? (!canEnableMore ? t('sections.allEnabled') : undefined) },
      { label: t('sections.disableAll'), icon: PowerOff, onSelect: () => onDisable(group), disabled: !canManage || busy || row.enabled === 0, reason: permission ?? (row.enabled === 0 ? t('sections.noneEnabled') : undefined) },
      { label: t('sections.edit'), icon: Pencil, onSelect: () => onEdit(group), disabled: !canManage, reason: permission ?? undefined },
      ...(applyOrder ? [{ label: t('panel.applyOrder'), icon: Wand2, onSelect: applyOrder.run, disabled: applyOrder.reason !== null, reason: applyOrder.reason ?? undefined }] : []),
    ]
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y border-border/60 bg-muted/50 px-2 py-1.5" data-group-section={group.id}>
        <h3 className="min-w-0">
          <button
            type="button"
            onClick={() => toggle(group.id)}
            aria-expanded={!row.collapsed}
            className="flex min-h-9 min-w-0 items-center gap-2 rounded-md px-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100', !row.collapsed && 'rotate-90 rtl:-rotate-90')} aria-hidden="true" />
            <GroupDot color={group.color} />
            <span className="truncate text-sm font-semibold text-foreground">{group.name}</span>
          </button>
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">{t('sections.enabledOf', { enabled: row.enabled, total: row.total })}</span>
        {summary && (
          <button
            type="button"
            onClick={() => onShowConflicts?.(group, summary)}
            disabled={!onShowConflicts}
            className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            aria-label={t('panel.conflictsBadgeAria', { count: summary.internal + summary.external, name: group.name })}
          >
            <ShieldAlert className="h-3 w-3 text-warning" aria-hidden="true" />
            {t('panel.conflictsBadge', { count: summary.internal + summary.external })}
          </button>
        )}
        {group.keepTogether && <span className="rounded-full border border-border/70 px-2 text-[11px] text-muted-foreground">{t('panel.keepsTogether')}</span>}
        <span className="ms-auto flex items-center gap-1">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
          {canEnableMore && (
            <DisabledReason reason={permission}>
              <Button variant="outline" size="sm" onClick={() => onEnable(group)} disabled={!canManage || busy}>
                <Power aria-hidden="true" />
                <span className="hidden sm:inline">{t('sections.enableAll')}</span>
                <span className="sr-only sm:hidden">{t('sections.enableAllAria', { name: group.name })}</span>
              </Button>
            </DisabledReason>
          )}
          <RowActions items={actions} ariaLabel={t('sections.actionsAria', { name: group.name })} />
        </span>
      </div>
    )
  }

  const renderRow = (row: SectionRow<T>) => {
    switch (row.kind) {
      case 'group':
        return renderGroupHeader(row)
      case 'item':
        return renderItem(row.item)
      case 'missing':
        return (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {t('sections.notOnServer', { ids: row.ids.map((id) => modNames.get(id) ?? id).join(', ') })}
          </p>
        )
      case 'ungrouped':
        return (
          <div className="flex items-center gap-2 border-y border-border/60 bg-muted/50 px-2 py-1.5">
            <h3 className="min-w-0">
              <button
                type="button"
                onClick={() => toggle(UNGROUPED)}
                aria-expanded={!row.collapsed}
                className="flex min-h-9 items-center gap-2 rounded-md px-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100', !row.collapsed && 'rotate-90 rtl:-rotate-90')} aria-hidden="true" />
                <ListOrdered className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-semibold text-foreground">{t('sections.ungrouped')}</span>
              </button>
            </h3>
            <span className="text-xs tabular-nums text-muted-foreground">{row.count}</span>
          </div>
        )
    }
  }

  const rowKey = (row: SectionRow<T>) =>
    row.kind === 'group' ? `g:${row.group.id}` : row.kind === 'item' ? `i:${row.groupId}:${row.item.key}` : row.kind === 'missing' ? `m:${row.groupId}` : 'u'

  return (
    <VirtualRows
      rows={rows}
      getKey={rowKey}
      renderRow={renderRow}
      estimateSize={(row) => (row.kind === 'item' ? 64 : 44)}
      className={className}
      listClassName="divide-y divide-border/50"
      virtualRowClassName={() => 'border-b border-border/50'}
    />
  )
}
