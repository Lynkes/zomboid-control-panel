import { useTranslation } from 'react-i18next'
import type { SmartConfidence } from '@/lib/api'
import { cn } from '@/lib/utils'

const FILLED: Record<SmartConfidence, number> = { high: 3, medium: 2, low: 1 }
const BAR_HEIGHTS = ['h-[5px]', 'h-[8px]', 'h-[11px]']
const TONE: Record<SmartConfidence, string> = {
  high: 'bg-success',
  medium: 'bg-warning',
  low: 'bg-muted-foreground/70',
}

/**
 * How sure the panel is about a suggestion, as three small bars (like a
 * signal meter): three for high, two for medium, one for low. Screen
 * readers hear the word; `showLabel` prints it too.
 */
export function ConfidenceMark({
  confidence,
  showLabel = false,
  className,
}: {
  confidence: SmartConfidence
  showLabel?: boolean
  className?: string
}) {
  const { t } = useTranslation('modsSmart')
  const label = t(`confidence.${confidence}`)
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground', className)} title={label}>
      <span role="img" aria-label={label} className="inline-flex h-3 items-end gap-px">
        {BAR_HEIGHTS.map((height, bar) => (
          <span key={bar} className={cn('w-[3px] rounded-[1px]', height, bar < FILLED[confidence] ? TONE[confidence] : 'bg-border')} />
        ))}
      </span>
      {showLabel && <span aria-hidden="true">{label}</span>}
    </span>
  )
}
