import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, ChevronUp, GripVertical, Loader2, Plus, Search, Undo2, Wand2, X } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import type { ModGroup, ModGroupColorName, ModGroupInput } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, moveListEntry } from '@/lib/modGroups'
import { MOD_GROUP_COLORS, autoOrderMembers, groupDotClass } from '@/lib/modGroupTools'
import type { GroupPlacement } from '@/lib/loadOrderAutoSort'
import { cn } from '@/lib/utils'

const MEMBER_BUTTON_CLASS =
  'inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-30'

// How many "Add mods" results are listed at once. A server with 250 mods and an
// empty search would otherwise put 250 buttons in a dialog.
const MAX_CANDIDATES = 50

/** Fewer than this and a group orders nothing. */
export const MIN_GROUP_MEMBERS = 2

type MemberAction = 'up' | 'down' | 'remove'
type PlacementChoice = 'anywhere' | GroupPlacement

/** What the dialog saves: the group itself, plus where Auto-sort places it (kept in this browser). */
export interface ModGroupDialogValues extends ModGroupInput {
  color: ModGroupColorName | null
  keepTogether: boolean
  placement: GroupPlacement | null
}

export interface ModGroupDialogProps {
  /** The group being edited, or null to create one. */
  group: ModGroup | null
  /** Creating only: the members to start with (the mods picked on the Load order tab, a suggestion), in load order. */
  initialModIds?: readonly string[]
  /** Creating only: a name to start with (a suggestion's). */
  initialName?: string
  /** The group's Auto-sort placement (kept in this browser). */
  placement?: GroupPlacement | null
  /** The mods enabled on the active server: what "Add mods" offers. */
  serverModIds: readonly string[]
  /** Mod ID to display name. */
  modNames: Readonly<Record<string, string>>
  /** Mod ID to its `require=` entries, for "Auto-order members". */
  requires?: ReadonlyMap<string, readonly string[]>
  onClose: () => void
  /** Saves the group. A rejection is shown in the dialog and keeps it open. */
  onSubmit: (values: ModGroupDialogValues) => Promise<void>
}

/**
 * Create / edit one mod group: its name, description, colour, whether its mods
 * load as one block, where Auto-sort places it, and the ordered member list.
 * The list order is the load order the members must keep. Mount it only while
 * it is open (the Mod groups panel does): its fields start from `group` each time.
 */
export function ModGroupDialog({
  group,
  initialModIds,
  initialName,
  placement: initialPlacement = null,
  serverModIds,
  modNames,
  requires,
  onClose,
  onSubmit,
}: ModGroupDialogProps) {
  const { t } = useTranslation('modGroups')
  const [name, setName] = useState(group?.name ?? initialName ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [members, setMembers] = useState<string[]>(() => group?.modIds ?? [...(initialModIds ?? [])])
  const [color, setColor] = useState<ModGroupColorName | null>(group?.color ?? null)
  const [keepTogether, setKeepTogether] = useState(group?.keepTogether === true)
  const [placement, setPlacement] = useState<PlacementChoice>(initialPlacement ?? 'anywhere')
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [beforeAutoOrder, setBeforeAutoOrder] = useState<string[] | null>(null)
  const [autoOrderNote, setAutoOrderNote] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef<{ id: string | null; action: MemberAction } | null>(null)

  const onServer = useMemo(() => new Set(serverModIds), [serverModIds])
  const memberSet = useMemo(() => new Set(members), [members])
  const absentCount = members.filter((id) => !onServer.has(id)).length

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    const seen = new Set<string>()
    const found: string[] = []
    for (const id of serverModIds) {
      if (seen.has(id) || memberSet.has(id)) continue
      seen.add(id)
      if (q && !id.toLowerCase().includes(q) && !(modNames[id] ?? '').toLowerCase().includes(q)) continue
      found.push(id)
    }
    return found
  }, [serverModIds, memberSet, modNames, query])

  const trimmedName = name.trim()
  const valid = trimmedName !== '' && members.length >= MIN_GROUP_MEMBERS
  const placementValue = placement === 'anywhere' ? null : placement
  const changed =
    !group ||
    trimmedName !== group.name ||
    description.trim() !== (group.description ?? '').trim() ||
    members.length !== group.modIds.length ||
    members.some((id, i) => id !== group.modIds[i]) ||
    color !== (group.color ?? null) ||
    keepTogether !== (group.keepTogether === true) ||
    placementValue !== (initialPlacement ?? null)

  // After a move or a remove, the row (or the control that was pressed) has
  // been re-rendered in a new place: put keyboard focus back where the user
  // was, so Enter/Space can be pressed again. A control that has nowhere left
  // to go (first row, "up") is disabled now, so focus goes to its sibling.
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    pendingFocus.current = null
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-member-id]') ?? [])
    const row = pending.id === null ? undefined : rows.find((el) => el.getAttribute('data-member-id') === pending.id)
    if (!row) {
      searchRef.current?.focus()
      return
    }
    const button = (action: MemberAction) => row.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
    const order: MemberAction[] =
      pending.action === 'up' ? ['up', 'down', 'remove'] : pending.action === 'down' ? ['down', 'up', 'remove'] : ['remove']
    for (const action of order) {
      const el = button(action)
      if (el && !el.disabled) {
        el.focus()
        return
      }
    }
  }, [members])

  const editMembers = (next: string[]) => {
    setMembers(next)
    // A manual edit replaces the auto-order the Undo would bring back.
    setBeforeAutoOrder(null)
    setAutoOrderNote(null)
  }

  const move = (index: number, delta: -1 | 1) => {
    const next = moveListEntry(members, index, index + delta)
    if (next === members) return
    const id = members[index]
    pendingFocus.current = { id, action: delta < 0 ? 'up' : 'down' }
    editMembers(next)
    setAnnouncement(t('dialog.movedAnnouncement', { id, position: index + delta + 1, total: members.length }))
  }

  const remove = (index: number) => {
    const neighbour = members[index + 1] ?? members[index - 1] ?? null
    pendingFocus.current = { id: neighbour, action: 'remove' }
    editMembers(members.filter((_, i) => i !== index))
  }

  const add = (id: string) => {
    if (memberSet.has(id)) return
    editMembers([...members, id])
    searchRef.current?.focus()
  }

  const autoOrder = () => {
    const result = autoOrderMembers(members, { requires, names: modNames })
    if (!result.changed) {
      setAutoOrderNote(t('dialog.autoOrderUnchanged'))
      return
    }
    setBeforeAutoOrder(members)
    setMembers(result.order)
    setAutoOrderNote(t('dialog.autoOrderDone'))
    setAnnouncement(t('dialog.autoOrderDone'))
  }

  const undoAutoOrder = () => {
    if (!beforeAutoOrder) return
    setMembers(beforeAutoOrder)
    setBeforeAutoOrder(null)
    setAutoOrderNote(null)
  }

  // Drag a member row by its handle; the arrow buttons stay the keyboard path.
  const dragOver = (index: number) => {
    if (dragIndex === null || dragIndex === index) return
    setMembers((current) => moveListEntry(current, dragIndex, index))
    setBeforeAutoOrder(null)
    setAutoOrderNote(null)
    setDragIndex(index)
  }

  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ name: trimmedName, description: description.trim(), modIds: members, color, keepTogether, placement: placementValue })
    } catch (err) {
      setError(getUserErrorMessage(err, t('dialog.saveFailedFallback')))
      setSaving(false)
    }
  }

  const emptyCandidates = candidates.length === 0

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group ? t('dialog.editTitle') : t('dialog.createTitle')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mod-group-name">{t('dialog.nameLabel')}</Label>
              <Input
                id="mod-group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('dialog.namePlaceholder')}
                maxLength={GROUP_NAME_MAX}
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mod-group-description">{t('dialog.descriptionLabel')}</Label>
              <Input
                id="mod-group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('dialog.descriptionPlaceholder')}
                maxLength={GROUP_DESCRIPTION_MAX}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p id="mod-group-color-label" className="text-sm font-medium leading-none">{t('dialog.colorLabel')}</p>
              <ColorPicker value={color} onChange={setColor} labelledBy="mod-group-color-label" />
            </div>
            <div className="space-y-1.5">
              <p id="mod-group-placement-label" className="text-sm font-medium leading-none">{t('dialog.placementLabel')}</p>
              <Segmented<PlacementChoice>
                value={placement}
                onValueChange={setPlacement}
                ariaLabel={t('dialog.placementLabel')}
                items={[
                  { value: 'anywhere', label: t('dialog.placementAnywhere') },
                  { value: 'first', label: t('dialog.placementFirst') },
                  { value: 'last', label: t('dialog.placementLast') },
                ]}
              />
              <p className="text-xs text-muted-foreground">{t('dialog.placementHint')}</p>
            </div>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="mod-group-keep-together">{t('dialog.keepTogetherLabel')}</Label>
              <p id="mod-group-keep-together-desc" className="text-xs text-muted-foreground">{t('dialog.keepTogetherHint')}</p>
            </div>
            <Switch
              id="mod-group-keep-together"
              checked={keepTogether}
              onCheckedChange={setKeepTogether}
              aria-describedby="mod-group-keep-together-desc"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <Label id="mod-group-members-label">{t('dialog.membersLabel')}</Label>
                <span className="text-xs tabular-nums text-muted-foreground">{t('dialog.memberCount', { count: members.length })}</span>
              </div>
              <div className="flex items-center gap-1">
                {beforeAutoOrder && (
                  <Button type="button" variant="ghost" size="sm" onClick={undoAutoOrder} disabled={saving}>
                    <Undo2 aria-hidden="true" />
                    {t('dialog.autoOrderUndo')}
                  </Button>
                )}
                <Button type="button" variant="outline" size="sm" onClick={autoOrder} disabled={saving || members.length < 2}>
                  <Wand2 aria-hidden="true" />
                  {t('dialog.autoOrder')}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{autoOrderNote ?? t('dialog.membersHint')}</p>
            {absentCount > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('dialog.absentWarning', { count: absentCount })}
              </p>
            )}
            {members.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
                {t('dialog.membersEmpty')}
              </p>
            ) : (
              <ol
                ref={listRef}
                aria-labelledby="mod-group-members-label"
                className="max-h-64 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-muted/30"
                onDrop={(e) => { e.preventDefault(); setDragIndex(null) }}
              >
                {members.map((id, index) => {
                  const displayName = modNames[id]
                  const absent = !onServer.has(id)
                  return (
                    <li
                      key={id}
                      data-member-id={id}
                      draggable={!saving}
                      onDragStart={(e) => {
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                        setDragIndex(index)
                      }}
                      onDragOver={(e) => { e.preventDefault(); dragOver(index) }}
                      onDragEnd={() => setDragIndex(null)}
                      className={cn('flex items-center gap-2 py-0.5 ps-1.5 pe-1', dragIndex === index && 'opacity-40')}
                    >
                      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/60" aria-hidden="true" />
                      <span className="w-5 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
                      <div className={`min-w-0 flex-1 ${absent ? 'opacity-60' : ''}`}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-xs">{id}</span>
                          {absent && (
                            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-medium">
                              {t('dialog.notOnServer')}
                            </Badge>
                          )}
                        </div>
                        {displayName && <p className="truncate text-[11px] text-muted-foreground">{displayName}</p>}
                      </div>
                      <div className="flex shrink-0">
                        <button
                          type="button"
                          data-action="up"
                          className={MEMBER_BUTTON_CLASS}
                          aria-label={t('dialog.moveUpAria', { id })}
                          disabled={saving || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ChevronUp className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          data-action="down"
                          className={MEMBER_BUTTON_CLASS}
                          aria-label={t('dialog.moveDownAria', { id })}
                          disabled={saving || index === members.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          data-action="remove"
                          className={`${MEMBER_BUTTON_CLASS} hover:text-destructive`}
                          aria-label={t('dialog.removeAria', { id })}
                          disabled={saving}
                          onClick={() => remove(index)}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
            <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mod-group-search">{t('dialog.addLabel')}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="mod-group-search"
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('dialog.searchPlaceholder')}
                autoComplete="off"
                className="ps-8"
              />
            </div>
            {emptyCandidates ? (
              <p className="px-1 text-xs text-muted-foreground">
                {query.trim() ? t('dialog.noMatches') : t('dialog.allAdded')}
              </p>
            ) : (
              <ul
                aria-label={t('dialog.addLabel')}
                className="max-h-48 divide-y divide-border/40 overflow-y-auto rounded-md border border-border/60"
              >
                {candidates.slice(0, MAX_CANDIDATES).map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      aria-label={t('dialog.addAria', { id })}
                      disabled={saving}
                      onClick={() => add(id)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-start text-xs transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="shrink-0 font-mono">{id}</span>
                      {modNames[id] && <span className="truncate text-muted-foreground">{modNames[id]}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {candidates.length > MAX_CANDIDATES && (
              <p className="px-1 text-[11px] text-muted-foreground">
                {t('dialog.showingFirst', { shown: MAX_CANDIDATES, total: candidates.length })}
              </p>
            )}
          </div>
        </DialogBody>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{t('dialog.saveFailedTitle')}</AlertTitle>
            <AlertDescription className="[overflow-wrap:anywhere]">{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          {members.length < MIN_GROUP_MEMBERS && (
            <p className="me-auto self-center text-xs text-muted-foreground">{t('dialog.needTwo')}</p>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('dialog.cancel')}
          </Button>
          <Button onClick={submit} disabled={!valid || !changed || saving}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {group ? t('dialog.saveChanges') : t('dialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The 11 group colours plus "none", as one radio group (arrow keys move and pick). */
function ColorPicker({ value, onChange, labelledBy }: { value: ModGroupColorName | null; onChange: (color: ModGroupColorName | null) => void; labelledBy: string }) {
  const { t } = useTranslation('modGroups')
  const options: Array<ModGroupColorName | null> = [null, ...MOD_GROUP_COLORS]
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(0, options.indexOf(value))
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl'
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
    const back = rtl ? 'ArrowRight' : 'ArrowLeft'
    let next: number | null = null
    if (event.key === forward || event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === back || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    if (next === null) return
    event.preventDefault()
    onChange(options[next])
    refs.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-1">
      {options.map((option, index) => {
        const checked = index === selected
        const label = t(`colors.${option ?? 'none'}`)
        return (
          <button
            key={option ?? 'none'}
            ref={(el) => { refs.current[index] = el }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'grid h-8 w-8 place-items-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
              checked ? 'border-foreground/70 bg-accent/40' : 'border-transparent hover:bg-accent/30',
            )}
          >
            <span className={cn('h-4 w-4 rounded-full', groupDotClass(option))} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
