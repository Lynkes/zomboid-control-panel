import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Backpack, ChevronDown, ChevronRight, Loader2, Package, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CharacterInventory as CharacterInventoryData, CharacterRow } from '@/lib/characterApi'
import {
  aggregateByType,
  filterTree,
  sortRows,
  totals,
  type InventoryAnnotation,
  type InventoryTypeAggregate,
} from '@/lib/characterInventory'
import { makeCollator } from '@/lib/characterLabels'
import { cn } from '@/lib/utils'
import { formatNumber, formatTime, formatWhen } from './characterFormat'

type View = 'tree' | 'type'

function RowBadges({
  row,
  annotation,
}: {
  row: { worn?: boolean; equipped?: 'primary' | 'secondary'; attached?: string; hidden?: boolean; obsolete?: boolean }
  annotation?: InventoryAnnotation
}) {
  const { t, i18n } = useTranslation('players')
  const badge = 'px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider'
  return (
    <>
      {row.equipped && (
        <Badge variant="outline" className={cn(badge, 'text-primary')}>
          {row.equipped === 'primary' ? t('character.inventory.primary') : t('character.inventory.secondary')}
        </Badge>
      )}
      {row.worn && <Badge variant="outline" className={cn(badge, 'text-muted-foreground')}>{t('character.inventory.worn')}</Badge>}
      {row.attached && (
        <Badge variant="outline" className={cn(badge, 'text-muted-foreground')}>
          {t('character.inventory.attachedTo', { slot: row.attached })}
        </Badge>
      )}
      {annotation?.debug && <Badge variant="outline" className={cn(badge, 'border-warning/50 text-warning')}>{t('character.inventory.debugItem')}</Badge>}
      {row.hidden && !row.worn && <Badge variant="outline" className={cn(badge, 'text-muted-foreground')}>{t('character.inventory.hiddenItem')}</Badge>}
      {row.obsolete && <Badge variant="outline" className={cn(badge, 'text-muted-foreground')}>{t('character.inventory.obsoleteItem')}</Badge>}
      {annotation?.givenAt && (
        <span className="text-[11px] text-muted-foreground">
          {t('character.inventory.givenViaPanel', { when: formatWhen(annotation.givenAt, i18n.language) })}
        </span>
      )}
    </>
  )
}

function FullType({ value }: { value?: string }) {
  if (!value) return null
  return (
    <bdi dir="ltr" className="truncate font-mono text-[11px] text-muted-foreground/80">
      {value}
    </bdi>
  )
}

function TreeRows({
  rows,
  depth,
  path,
  collapsed,
  toggle,
  annotations,
}: {
  rows: CharacterRow[]
  depth: number
  path: string
  collapsed: Set<string>
  toggle: (key: string) => void
  annotations: Map<string, InventoryAnnotation>
}) {
  const { t, i18n } = useTranslation('players')
  const language = i18n.language
  return (
    <ul className={cn('space-y-1', depth > 0 && 'ms-4 border-s border-border/40 ps-3')}>
      {rows.map((row, index) => {
        const key = `${path}.${index}`
        const annotation = row.fullType ? annotations.get(row.fullType) : undefined
        if (row.kind === 'container') {
          const open = !collapsed.has(key)
          const name = row.name ?? row.fullType ?? ''
          return (
            <li key={key}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0"
                  aria-expanded={open}
                  aria-label={open ? t('character.inventory.collapse', { name }) : t('character.inventory.expand', { name })}
                  onClick={() => toggle(key)}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" />}
                </Button>
                <Backpack className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden="true" />
                <span className="text-sm">{name}</span>
                <FullType value={row.fullType} />
                {typeof row.contentsWeight === 'number' && typeof row.capacity === 'number' && (
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {t('character.inventory.capacity', {
                      used: formatNumber(row.contentsWeight, language, 1),
                      capacity: formatNumber(row.capacity, language, 1),
                    })}
                  </span>
                )}
                {typeof row.itemCount === 'number' && (
                  <span className="text-[11px] text-muted-foreground">{t('character.inventory.inside', { number: row.itemCount })}</span>
                )}
                <RowBadges row={row} annotation={annotation} />
              </div>
              {open && row.rows.length > 0 && (
                <TreeRows rows={row.rows} depth={depth + 1} path={key} collapsed={collapsed} toggle={toggle} annotations={annotations} />
              )}
            </li>
          )
        }
        return (
          <li key={key} className="flex flex-wrap items-center gap-x-2 gap-y-1 ps-9">
            <span className="text-sm">{row.name ?? row.fullType}</span>
            <FullType value={row.fullType} />
            {typeof row.qty === 'number' && row.qty > 1 && (
              <span className="font-mono text-xs tabular-nums text-foreground/85">{t('character.inventory.qty', { qty: formatNumber(row.qty, language) })}</span>
            )}
            {typeof row.condition === 'number' && typeof row.conditionMax === 'number' && row.conditionMax > 0 && (
              <span className="text-[11px] text-muted-foreground">
                {t('character.inventory.condition', { condition: row.condition, max: row.conditionMax })}
              </span>
            )}
            <RowBadges row={row} annotation={annotation} />
          </li>
        )
      })}
    </ul>
  )
}

function TypeRows({ items, annotations }: { items: InventoryTypeAggregate[]; annotations: Map<string, InventoryAnnotation> }) {
  const { t, i18n } = useTranslation('players')
  const language = i18n.language
  return (
    <ul className="divide-y divide-border/40">
      {items.map((item) => (
        <li key={item.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
          <Package className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden="true" />
          <span className="text-sm">{item.name ?? item.fullType}</span>
          <FullType value={item.fullType} />
          <span className="font-mono text-xs tabular-nums text-foreground/85">{t('character.inventory.qty', { qty: formatNumber(item.qty, language) })}</span>
          {item.modId && item.modId !== 'pz-vanilla' && (
            <span className="text-[11px] text-muted-foreground">
              {t('character.inventory.mod', { mod: item.modId })}
            </span>
          )}
          <RowBadges
            row={{ worn: item.worn, hidden: item.hidden, obsolete: item.obsolete }}
            annotation={item.fullType ? annotations.get(item.fullType) : undefined}
          />
        </li>
      ))}
    </ul>
  )
}

export interface CharacterInventoryProps {
  inventory: CharacterInventoryData | null
  /** When this inventory was read live. */
  loadedAt?: string | null
  /** Set when showing what the panel saved rather than a live read. */
  savedAt?: string | null
  requested: boolean
  loading: boolean
  error: string | null
  canLoad: boolean
  onLoad: () => void
  onVisibleChange: (visible: boolean) => void
  annotations: Map<string, InventoryAnnotation>
  sectionError?: string
}

export function CharacterInventory({
  inventory,
  loadedAt,
  savedAt,
  requested,
  loading,
  error,
  canLoad,
  onLoad,
  onVisibleChange,
  annotations,
  sectionError,
}: CharacterInventoryProps) {
  const { t, i18n } = useTranslation('players')
  const language = i18n.language
  const collator = useMemo(() => makeCollator(language), [language])
  const [view, setView] = useState<View>('tree')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  // Polled only while it's on screen: shown, and asked for.
  useEffect(() => {
    onVisibleChange(requested)
    return () => onVisibleChange(false)
  }, [requested, onVisibleChange])

  const rootRows = useMemo(() => inventory?.root?.rows ?? [], [inventory])
  const filtered = useMemo(() => filterTree(rootRows, query), [rootRows, query])
  const sortedTree = useMemo(() => sortRows(filtered.rows, 'name', collator), [filtered.rows, collator])
  const byType = useMemo(() => sortRows(aggregateByType(filtered.rows), 'name', collator), [filtered.rows, collator])
  const all = useMemo(() => totals(rootRows), [rootRows])
  const toggle = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const wornEquipped: Array<{ key: string; row: CharacterRow }> = []
  if (inventory) {
    if (inventory.equipped.primary) wornEquipped.push({ key: 'primary', row: inventory.equipped.primary })
    if (inventory.equipped.secondary) wornEquipped.push({ key: 'secondary', row: inventory.equipped.secondary })
    inventory.worn.forEach((row, i) => wornEquipped.push({ key: `worn.${i}`, row }))
    inventory.attached.forEach((row, i) => wornEquipped.push({ key: `attached.${i}`, row }))
  }
  const totalsInfo = inventory?.totals ?? {}
  const truncatedDepth = useMemo(() => {
    const walk = (rows: CharacterRow[]): boolean =>
      rows.some((row) => row.kind === 'container' && (row.truncatedDepth === true || walk(row.rows)))
    return walk(rootRows)
  }, [rootRows])

  return (
    <section className="space-y-3" aria-labelledby="character-inventory-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="character-inventory-heading" className="flex items-center gap-2 text-sm font-medium">
          <Backpack className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('character.inventory.title')}
        </h3>
        {inventory && (
          <span className="text-[11px] text-muted-foreground">
            {savedAt
              ? t('character.inventory.lastKnown', { when: formatWhen(savedAt, language) })
              : loadedAt
                ? t('character.inventory.loadedAt', { time: formatTime(loadedAt, language) })
                : null}
            {loading && <Loader2 className="ms-1.5 inline h-3 w-3 animate-spin" aria-hidden="true" />}
          </span>
        )}
      </div>
      {sectionError && <p className="text-xs text-muted-foreground">{t('character.state.sectionFailed', { reason: sectionError })}</p>}

      {!inventory ? (
        loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('character.inventory.loading')}
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-destructive">{error}</span>
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={onLoad}>
              {t('character.state.retry')}
            </Button>
          </div>
        ) : canLoad ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={onLoad}>
              <Backpack className="h-3.5 w-3.5" aria-hidden="true" />
              {t('character.inventory.load')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('character.inventory.intro')}</p>
          </div>
        ) : null
      ) : (
        <>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {t('character.inventory.summaryLine', {
              items: formatNumber(totalsInfo.itemCount ?? all.units, language),
              types: formatNumber(totalsInfo.distinctTypes ?? all.types, language),
            })}
          </p>
          {(totalsInfo.truncated || truncatedDepth || (typeof totalsInfo.skipped === 'number' && totalsInfo.skipped > 0)) && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {totalsInfo.truncated && totalsInfo.truncatedReason === 'timeBudget' ? (
                <li>{t('character.inventory.timeBudget', { ms: totalsInfo.budgetMs ?? '?' })}</li>
              ) : totalsInfo.truncated ? (
                <li>{t('character.inventory.truncated', { maxItems: totalsInfo.maxItems ?? all.units })}</li>
              ) : null}
              {truncatedDepth && <li>{t('character.inventory.truncatedDepth', { depth: totalsInfo.maxDepth ?? 4 })}</li>}
              {typeof totalsInfo.skipped === 'number' && totalsInfo.skipped > 0 && (
                <li>{t('character.inventory.skipped', { number: totalsInfo.skipped })}</li>
              )}
            </ul>
          )}

          {wornEquipped.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('character.inventory.wornEquipped')}</p>
              <ul className="flex flex-wrap gap-1.5">
                {wornEquipped.map(({ key, row }) => (
                  <li key={key} className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/25 px-2 py-1">
                    <span className="text-xs">{row.name ?? row.fullType}</span>
                    <RowBadges row={row} annotation={row.fullType ? annotations.get(row.fullType) : undefined} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t('character.inventory.viewLabel')} className="flex rounded-md border border-border/60 p-0.5">
              {(['tree', 'type'] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={view === option ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  aria-pressed={view === option}
                  onClick={() => setView(option)}
                >
                  {option === 'tree' ? t('character.inventory.viewTree') : t('character.inventory.viewByType')}
                </Button>
              ))}
            </div>
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('character.inventory.search')}
                aria-label={t('character.inventory.searchAria')}
                className="h-8 ps-8 text-sm"
              />
            </div>
          </div>

          {rootRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('character.inventory.empty')}</p>
          ) : filtered.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('character.inventory.noMatches', { query: query.trim() })}</p>
          ) : view === 'tree' ? (
            <TreeRows rows={sortedTree} depth={0} path="root" collapsed={collapsed} toggle={toggle} annotations={annotations} />
          ) : (
            <TypeRows items={byType} annotations={annotations} />
          )}
        </>
      )}
    </section>
  )
}
