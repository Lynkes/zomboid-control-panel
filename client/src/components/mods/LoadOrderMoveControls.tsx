import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react'
import { DisabledReason } from '@/components/DisabledReason'
import { loadOrderMoveTarget, type LoadOrderMove } from '@/lib/modLoadOrder'

const CONTROL_CLASS =
  'p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50'

export interface LoadOrderMoveControlsProps {
  /** 0-based position in the FULL load order, not in a filtered view of it. */
  index: number
  /** Length of the full load order. */
  total: number
  /** The mod ID the row shows; every control's accessible name includes it. */
  modId: string
  /** Called with this row's `index`. Pass a stable function -- see memo below. */
  onMove: (index: number, move: LoadOrderMove) => void
  /**
   * Turns every control off at once, for a state that locks the whole list
   * (Save Order in flight, an Auto-sort proposal open). The page states that
   * reason once, above the list: a DisabledReason here would put four
   * tooltips and four dead Tab stops on each of 200+ rows.
   */
  disabled?: boolean
}

/**
 * Move to top / up / down / to bottom for one Load Order row. Each button
 * carries `data-move-action` so the page can put focus back on a control of
 * this row after it has jumped (see Mods.tsx's moveModInLoadOrder); a
 * control with nowhere to go is disabled and says why instead of no-opping.
 * Strings live with the rest of the Load Order tab in mods.json (loadOrder.*).
 *
 * Memoized because it renders once per row of a list that can hold 200+
 * mods, inside a page that re-renders on every keystroke and socket event.
 * The page keeps `onMove` stable across those unrelated re-renders, so they
 * skip every row; a move itself changes `onMove` (it closes over the order)
 * and re-renders all rows' controls, once per click.
 */
export const LoadOrderMoveControls = memo(function LoadOrderMoveControls({
  index,
  total,
  modId,
  onMove,
  disabled = false,
}: LoadOrderMoveControlsProps) {
  const { t } = useTranslation('mods')
  const controls: Array<{ move: LoadOrderMove; Icon: LucideIcon; label: string; hint: string }> = [
    { move: 'top', Icon: ArrowUpToLine, label: t('loadOrder.moveToTopAria', { name: modId }), hint: t('loadOrder.moveToTopHint') },
    { move: 'up', Icon: ChevronUp, label: t('loadOrder.moveUpAria', { name: modId }), hint: t('loadOrder.moveUpHint') },
    { move: 'down', Icon: ChevronDown, label: t('loadOrder.moveDownAria', { name: modId }), hint: t('loadOrder.moveDownHint') },
    { move: 'bottom', Icon: ArrowDownToLine, label: t('loadOrder.moveToBottomAria', { name: modId }), hint: t('loadOrder.moveToBottomHint') },
  ]
  return (
    <div className="flex shrink-0">
      {controls.map(({ move, Icon, label, hint }) => {
        const icon = <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        const atEdge = loadOrderMoveTarget(index, total, move) === null
        if (disabled || atEdge) {
          const button = (
            <button key={move} type="button" data-move-action={move} disabled className={CONTROL_CLASS} aria-label={label}>
              {icon}
            </button>
          )
          if (disabled) return button
          const reason = move === 'top' || move === 'up' ? t('loadOrder.alreadyFirst') : t('loadOrder.alreadyLast')
          return (
            <DisabledReason key={move} reason={reason}>
              {button}
            </DisabledReason>
          )
        }
        // Plain title, not a Radix Tooltip: a Tooltip root on each of four
        // buttons per row measurably slowed rendering a 250-mod list. Only
        // the (at most four) disabled controls pay for DisabledReason's.
        return (
          <button
            key={move}
            type="button"
            data-move-action={move}
            onClick={() => onMove(index, move)}
            className={CONTROL_CLASS}
            aria-label={label}
            title={hint}
          >
            {icon}
          </button>
        )
      })}
    </div>
  )
})
