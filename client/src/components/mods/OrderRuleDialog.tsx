import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Pin, Search } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import type { ModOrderRule } from '@/lib/api'
import { cn } from '@/lib/utils'
import { findOppositeRule, findSameRule, type OrderRulesStore } from './useOrderRules'
import { useOrderRuleErrorText, type OrderRuleErrorExplanation } from './orderRuleErrors'
import { OrderRuleErrorNotice } from './OrderRuleErrorNotice'

/** The server's note limit (MOD_ORDER_RULE_LIMITS.noteMax). */
export const ORDER_RULE_NOTE_MAX = 300
/** Rows the picker renders at most; typing narrows the rest. */
export const PICKER_MAX_ROWS = 200

export interface OrderRuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  modId: string
  /** 'after': modId always loads after the picked mod; 'before': before it. */
  direction: 'after' | 'before'
  /** Mods to pick from, in the current load order (modId itself excluded by the dialog). */
  candidates: readonly string[]
  modNames: ReadonlyMap<string, string>
  store: OrderRulesStore
  /** After a rule was stored (the page re-plans). */
  onAdded?: (rule: ModOrderRule) => void
}

/**
 * "Always load X after…" / "before…": pick the other mod from a searchable
 * list (in load order), add an optional note, pin it. A rule that would make
 * a loop is explained inline, link by link; a rule the other way round is
 * replaced only after asking.
 */
export function OrderRuleDialog({ open, onOpenChange, modId, direction, candidates, modNames, store, onAdded }: OrderRuleDialogProps) {
  const { t } = useTranslation('modRules')
  const { toast } = useToast()
  const confirm = useConfirm()
  const explain = useOrderRuleErrorText(modNames, store.max)
  const listId = useId()
  const optionPrefix = useId()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<OrderRuleErrorExplanation | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // A fresh form each time it opens (or for another mod or side).
  useEffect(() => {
    if (!open) return
    setQuery('')
    setPicked(null)
    setActive(0)
    setNote('')
    setSaving(false)
    setError(null)
  }, [open, modId, direction])

  const name = (id: string) => modNames.get(id) ?? id
  const label = (id: string) => {
    const shown = modNames.get(id)
    return shown && shown !== id ? shown : id
  }

  const positions = useMemo(() => new Map(candidates.map((id, index) => [id, index + 1])), [candidates])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of candidates) {
      if (id === modId || seen.has(id)) continue
      seen.add(id)
      if (q && !id.toLowerCase().includes(q) && !(modNames.get(id) ?? '').toLowerCase().includes(q)) continue
      out.push(id)
    }
    return out
  }, [candidates, modId, modNames, query])
  const shown = matches.slice(0, PICKER_MAX_ROWS)
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1))

  // The pair the rule would store, for the picked mod.
  const pairFor = (other: string) => (direction === 'after' ? { before: other, after: modId } : { before: modId, after: other })
  const alreadyPinned = (other: string) => {
    const { before, after } = pairFor(other)
    return !!findSameRule(store.rules, before, after)
  }

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const pick = (id: string) => {
    if (alreadyPinned(id)) return
    setPicked(id)
    setError(null)
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (shown.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(activeIndex + 1, shown.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault()
      setActive(shown.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const id = shown[activeIndex]
      if (id) pick(id)
    }
  }

  const submit = async () => {
    if (!picked || saving) return
    const { before, after } = pairFor(picked)
    const opposite = findOppositeRule(store.rules, before, after)
    if (opposite) {
      const ok = await confirm({
        title: t('dialog.replaceTitle'),
        description: t('dialog.replaceDesc', { before: name(before), after: name(after) }),
        confirmLabel: t('dialog.replaceConfirm'),
        variant: 'warning',
      })
      if (!ok) return
    }
    setSaving(true)
    setError(null)
    try {
      const trimmed = note.trim()
      const result = await store.add({
        before,
        after,
        source: 'manual',
        ...(trimmed ? { note: trimmed } : {}),
        ...(opposite ? { replaceOpposite: true } : {}),
      })
      toast(result.existing
        ? { title: t('dialog.existingTitle'), description: t('dialog.existingDesc', { before: name(before), after: name(after) }) }
        : { title: t('dialog.addedTitle'), description: t('dialog.addedDesc', { before: name(before), after: name(after) }) })
      onAdded?.(result.rule)
      onOpenChange(false)
    } catch (err) {
      setError(explain(err))
    } finally {
      setSaving(false)
    }
  }

  const activeOptionId = shown.length > 0 ? `${optionPrefix}-${activeIndex}` : undefined

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">
            {direction === 'after' ? t('dialog.titleAfter', { mod: label(modId) }) : t('dialog.titleBefore', { mod: label(modId) })}
          </DialogTitle>
          <DialogDescription>{direction === 'after' ? t('dialog.descAfter') : t('dialog.descBefore')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${listId}-search`}>{t('dialog.searchLabel')}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id={`${listId}-search`}
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActive(0) }}
                onKeyDown={onSearchKeyDown}
                placeholder={t('dialog.searchPlaceholder')}
                autoFocus
                autoComplete="off"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
                className="ps-9"
              />
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={t('dialog.listAria')}
              className="max-h-64 overflow-y-auto rounded-lg border border-border/60 bg-background/40"
            >
              {shown.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('dialog.noMatches', { query: query.trim() })}</p>
              ) : (
                shown.map((id, index) => {
                  const pinned = alreadyPinned(id)
                  const selected = picked === id
                  const display = modNames.get(id)
                  return (
                    <div
                      key={id}
                      id={`${optionPrefix}-${index}`}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={pinned || undefined}
                      data-option-index={index}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(id)}
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-1.5 text-sm last:border-b-0 sm:min-h-9',
                        index === activeIndex && 'bg-accent/40',
                        selected && 'bg-primary/10',
                        pinned && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className="w-10 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                        {t('dialog.position', { position: positions.get(id) ?? 0 })}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground" dir="auto">{display && display !== id ? display : id}</span>
                        {display && display !== id && <span className="block truncate font-mono text-xs text-muted-foreground">{id}</span>}
                      </span>
                      {pinned && <span className="shrink-0 text-xs text-muted-foreground">{t('dialog.alreadyPinned')}</span>}
                      {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                    </div>
                  )
                })
              )}
            </div>
            {matches.length > shown.length && (
              <p className="text-xs text-muted-foreground">{t('dialog.truncated', { shown: shown.length, total: matches.length })}</p>
            )}
          </div>

          <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-foreground" aria-live="polite">
            {picked
              ? direction === 'after'
                ? t('dialog.previewAfter', { mod: label(modId), other: label(picked) })
                : t('dialog.previewBefore', { mod: label(modId), other: label(picked) })
              : <span className="text-muted-foreground">{t('dialog.pickFirst')}</span>}
          </p>

          <div className="space-y-2">
            <Label htmlFor={`${listId}-note`}>{t('dialog.noteLabel')}</Label>
            <Textarea
              id={`${listId}-note`}
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, ORDER_RULE_NOTE_MAX))}
              maxLength={ORDER_RULE_NOTE_MAX}
              placeholder={t('dialog.notePlaceholder')}
              className="min-h-20"
              aria-describedby={`${listId}-note-count`}
            />
            <p id={`${listId}-note-count`} className="text-end text-xs tabular-nums text-muted-foreground">
              {t('dialog.noteCounter', { length: note.length, max: ORDER_RULE_NOTE_MAX })}
            </p>
          </div>

          {error && <OrderRuleErrorNotice explanation={error} />}
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('dialog.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={!picked || saving}>
            {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {t('dialog.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
