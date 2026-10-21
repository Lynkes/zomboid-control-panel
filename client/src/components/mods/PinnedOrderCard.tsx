import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Pin, Search, Trash2 } from 'lucide-react'
import { SectionCard } from '@/components/ui/section-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { DisabledReason } from '@/components/DisabledReason'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import type { ModOrderRule } from '@/lib/api'
import { useDateFormat } from '@/lib/dateFormat'
import { getUserErrorMessage } from '@/lib/errorMessage'
import type { OrderRulesStore } from './useOrderRules'

/** Above this many rules the card offers a filter. */
const FILTER_AT = 8

export interface PinnedOrderCardProps {
  store: OrderRulesStore
  /** Mod IDs in Mods= now: a rule naming another mod shows as inactive. */
  enabledModIds: ReadonlySet<string>
  modNames: ReadonlyMap<string, string>
  canManage: boolean
  /** After a delete (the page re-plans). */
  onChanged?: () => void
}

/**
 * The pinned order: every rule "X always loads after Y" with its note, where
 * it came from, who set it and when. A rule naming a mod that is not enabled
 * is kept and shown as inactive. Rules are added from a Load order row's
 * menu or by applying a suggested conflict winner.
 */
export function PinnedOrderCard({ store, enabledModIds, modNames, canManage, onChanged }: PinnedOrderCardProps) {
  const { t } = useTranslation('modRules')
  const { formatDate } = useDateFormat()
  const { toast } = useToast()
  const confirm = useConfirm()
  const [query, setQuery] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const { rules, max, loadState } = store

  const name = (id: string) => modNames.get(id) ?? id
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!q) return rules
    return rules.filter((rule) =>
      [rule.before, rule.after, modNames.get(rule.before) ?? '', modNames.get(rule.after) ?? '', rule.note].some((text) => text.toLowerCase().includes(q)))
  }, [rules, q, modNames])

  const handleDelete = async (rule: ModOrderRule) => {
    if (!canManage) return
    const ok = await confirm({
      title: t('card.deleteTitle'),
      description: t('card.deleteDesc', { after: name(rule.after), before: name(rule.before) }),
      confirmLabel: t('card.deleteConfirm'),
      destructive: true,
    })
    if (!ok) return
    setDeleting(rule.id)
    try {
      await store.remove(rule.id)
      toast({ title: t('card.deletedTitle'), description: t('card.ruleSentence', { after: name(rule.after), before: name(rule.before) }) })
      onChanged?.()
    } catch (error) {
      toast({ title: t('card.deleteFailedTitle'), description: getUserErrorMessage(error, t('card.deleteFailedFallback')), variant: 'destructive' })
    } finally {
      setDeleting(null)
    }
  }

  const renderRule = (rule: ModOrderRule) => {
    const notEnabled = [rule.after, rule.before].filter((id) => !enabledModIds.has(id))
    const showIds = modNames.has(rule.after) || modNames.has(rule.before)
    const deleteAria = t('card.deleteAria', { after: name(rule.after), before: name(rule.before) })
    return (
      <li key={rule.id} className="flex items-start gap-3 px-4 py-3" data-rule-id={rule.id}>
        <Pin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
            <span className="min-w-0 break-words" dir="auto">{t('card.ruleSentence', { after: name(rule.after), before: name(rule.before) })}</span>
            {notEnabled.length > 0 && (
              <span
                className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] text-muted-foreground"
                title={t('card.inactiveTitle', { mods: notEnabled.join(', ') })}
              >
                {t('card.inactive')}
                <span className="sr-only">: {t('card.inactiveTitle', { mods: notEnabled.join(', ') })}</span>
              </span>
            )}
          </p>
          {showIds && (
            <p className="break-all font-mono text-xs text-muted-foreground">{t('card.ruleIds', { after: rule.after, before: rule.before })}</p>
          )}
          {rule.note && <p className="whitespace-pre-wrap break-words text-xs text-foreground" dir="auto">{rule.note}</p>}
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{t(`source.${rule.source}`)}</span>
            {rule.createdBy && <span>· {t('card.by', { name: rule.createdBy })}</span>}
            {rule.createdAt && <span>· {formatDate(rule.createdAt)}</span>}
          </p>
        </div>
        <DisabledReason reason={!canManage ? t('card.noPermission') : null}>
          <Button
            variant="ghost"
            size="iconDense"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => void handleDelete(rule)}
            disabled={!canManage || deleting === rule.id}
            aria-label={deleteAria}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </DisabledReason>
      </li>
    )
  }

  return (
    <SectionCard
      title={t('card.title')}
      description={t('card.description')}
      icon={Pin}
      collapsible
      storageKey="zcp:mods:order:pinnedOpen"
      flush
      status={loadState === 'ready' && rules.length > 0 ? (
        <span className="text-xs tabular-nums text-muted-foreground">{t('card.count', { count: rules.length, max })}</span>
      ) : undefined}
    >
      {loadState === 'error' && rules.length === 0 ? (
        <div className="m-4 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-foreground">{t('card.loadFailed')}</span>
          <Button variant="outline" size="sm" onClick={() => void store.reload()}>{t('card.retry')}</Button>
        </div>
      ) : (loadState === 'loading' || loadState === 'idle') && rules.length === 0 ? (
        <div className="space-y-2 p-4" aria-hidden="true">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : rules.length === 0 ? (
        <EmptyState type="noData" compact title={t('card.emptyTitle')} description={t('card.emptyDesc')} />
      ) : (
        <>
          {rules.length > FILTER_AT && (
            <div className="border-b border-border/60 p-4">
              <div className="relative max-w-sm">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('card.filterPlaceholder')}
                  aria-label={t('card.filterAria')}
                  className="ps-9"
                />
              </div>
            </div>
          )}
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('card.noMatches', { query: query.trim() })}</p>
          ) : (
            <ul className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto">{shown.map(renderRule)}</ul>
          )}
        </>
      )}
    </SectionCard>
  )
}
