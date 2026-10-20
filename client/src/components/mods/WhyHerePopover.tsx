import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpToLine, Loader2, MoveVertical, Pin, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { LoadOrderPlan, ModGroup, ModInsight, ModOrderRule } from '@/lib/api'
import { GroupDot } from './GroupDots'
import { KindChip } from './KindChip'
import { explanationsOf } from './useLoadOrderPlan'
import { useSmartText } from './smartText'

const NARROW_QUERY = '(max-width: 639px)'

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NARROW_QUERY)
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return narrow
}

export interface WhyHereProps {
  /** The mod asked about; null closes it. */
  modId: string | null
  /** The button it was opened from (the popover points at it; focus returns to it). */
  anchor: HTMLElement | null
  onClose: () => void
  order: readonly string[]
  plan: LoadOrderPlan | null
  /** The plan is for the order on screen (else it is being planned again). */
  fresh: boolean
  loading: boolean
  insight: ModInsight | undefined
  modNames: ReadonlyMap<string, string>
  groupsById: ReadonlyMap<string, ModGroup>
  groups: readonly ModGroup[]
  rules: readonly ModOrderRule[]
  canManage: boolean
  /** Opens the "Always load after/before…" picker. */
  onPin?: (modId: string, direction: 'after' | 'before') => void
  /** Opens the smart sort preview; null hides the button (locked). */
  onSortNow?: (() => void) | null
}

/**
 * "Why is it here?" for one Load order row: the reasons from a plan of the
 * order on screen, where smart sort would move it, its kind, what it requires
 * and what needs it, the order rules and groups naming it. A popover on wide
 * screens, a dialog on phones.
 */
export function WhyHerePopover(props: WhyHereProps) {
  const { modId, anchor, onClose } = props
  const narrow = useIsNarrow()
  const anchorRef = useRef<HTMLElement | null>(anchor)
  anchorRef.current = anchor
  const open = modId !== null

  const title = <WhyHereTitle {...props} />
  if (narrow) {
    return (
      <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogBody>{modId && <WhyHereBody {...props} modId={modId} />}</DialogBody>
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <PopoverAnchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <PopoverContent
        side="left"
        align="start"
        className="w-[min(26rem,calc(100vw-2rem))] space-y-3 p-4"
        aria-labelledby="why-here-title"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          anchorRef.current?.focus({ preventScroll: true })
        }}
      >
        <h3 id="why-here-title" className="text-sm font-semibold text-foreground">{title}</h3>
        {modId && <WhyHereBody {...props} modId={modId} />}
      </PopoverContent>
    </Popover>
  )
}

function WhyHereTitle({ modId, modNames }: WhyHereProps) {
  const text = useSmartText((id) => id, (id) => id)
  if (!modId) return null
  return <>{text.t('why.title', { mod: modNames.get(modId) ?? modId })}</>
}

function WhyHereBody({
  modId,
  order,
  plan,
  fresh,
  loading,
  insight,
  modNames,
  groupsById,
  groups,
  rules,
  canManage,
  onPin,
  onSortNow,
}: WhyHereProps & { modId: string }) {
  const name = useCallback((id: string) => modNames.get(id) ?? id, [modNames])
  const groupName = useCallback((id: string, fallback?: string) => groupsById.get(id)?.name || fallback || id, [groupsById])
  const text = useSmartText(name, groupName)
  const { t } = text
  const position = order.indexOf(modId)
  const reasons = explanationsOf(plan, modId)
  const move = fresh ? plan?.moves.find((m) => m.modId === modId) : undefined
  const memberOf = useMemo(() => groups.filter((g) => g.modIds.includes(modId)), [groups, modId])

  return (
    <div className="space-y-3 text-xs">
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span className="font-mono text-foreground">{modId}</span>
        {position >= 0 && <span className="tabular-nums">{t('why.position', { position: position + 1, total: order.length })}</span>}
        <KindChip insight={insight} name={name} />
      </p>

      {move && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <MoveVertical className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
            {t('why.wouldMove', { to: move.to + 1 })}
          </p>
          {onSortNow && (
            <Button variant="outline" size="sm" onClick={onSortNow}>
              <Wand2 aria-hidden="true" />
              {t('why.sortNow')}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-1">
        <p className="label-micro flex items-center gap-1.5">
          {plan?.changed && fresh ? t('why.reasonsPlanned') : t('why.reasonsTitle')}
          {(loading || !fresh) &&<Loader2 className="h-3 w-3 animate-spin" aria-label={t('why.updating')} />}
        </p>
        {!plan ? (
          <p className="text-muted-foreground">{loading ? t('why.updating') : t('why.unavailable')}</p>
        ) : reasons.length === 0 ? (
          <p className="text-muted-foreground">{t('why.noReasons')}</p>
        ) : (
          <ul className="list-disc space-y-0.5 ps-4 text-foreground">
            {reasons.map((reason, i) => <li key={i}>{text.reasonText(reason)}</li>)}
          </ul>
        )}
      </div>

      {insight && (insight.requires.length > 0 || insight.requiredBy.length > 0) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border/50 pt-3">
          {insight.requires.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t('why.requires')}</dt>
              <dd className="break-words text-foreground">{insight.requires.map(name).join(', ')}</dd>
            </>
          )}
          {insight.requiredBy.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t('neededBy', { count: insight.requiredBy.length })}</dt>
              <dd className="break-words text-foreground">{insight.requiredBy.slice(0, 12).map(name).join(', ')}{insight.requiredBy.length > 12 ? ` +${insight.requiredBy.length - 12}` : ''}</dd>
            </>
          )}
        </dl>
      )}

      {(rules.length > 0 || memberOf.length > 0) && (
        <div className="space-y-1 border-t border-border/50 pt-3">
          {rules.map((rule) => (
            <p key={rule.id} className="flex items-center gap-1.5 text-foreground">
              <Pin className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
              {rule.after === modId ? t('why.ruleAfter', { other: name(rule.before) }) : t('why.ruleBefore', { other: name(rule.after) })}
            </p>
          ))}
          {memberOf.map((group) => (
            <p key={group.id} className="flex items-center gap-1.5 text-foreground">
              <GroupDot color={group.color} />
              {t('why.inGroup', { group: group.name })}
              {group.placement && <span className="text-muted-foreground">· {t(group.placement === 'first' ? 'why.groupFirst' : 'why.groupLast')}</span>}
            </p>
          ))}
        </div>
      )}

      {canManage && onPin && (
        <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3">
          <Button variant="outline" size="sm" onClick={() => onPin(modId, 'after')}>
            <ArrowDownToLine aria-hidden="true" />
            {t('why.pinAfter')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onPin(modId, 'before')}>
            <ArrowUpToLine aria-hidden="true" />
            {t('why.pinBefore')}
          </Button>
        </div>
      )}
    </div>
  )
}
