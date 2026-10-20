import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModInsight } from '@/lib/api'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isShownKind, useSmartText } from './smartText'

const KIND_TONE: Record<string, string> = {
  library: 'border-info/40 bg-info/10',
  framework: 'border-info/40 bg-info/10',
  map: 'border-success/30 bg-success/10',
  translation: 'border-border/70 bg-muted/40',
  patch: 'border-warning/40 bg-warning/10',
  tweak: 'border-warning/30 bg-warning/5',
  ui: 'border-primary/30 bg-primary/10',
}

const identity = (id: string) => id

/**
 * What kind of mod this is (Library, Map, Patch, ...), with why the panel
 * thinks so in its tooltip. Nothing for content and unknown mods. Libraries
 * and frameworks say how many enabled mods need them.
 */
export const KindChip = memo(function KindChip({
  insight,
  name = identity,
  showDependents = false,
  className,
}: {
  insight: ModInsight | undefined
  name?: (modId: string) => string
  /** "· 12" after a library's label: how many enabled mods need it. */
  showDependents?: boolean
  className?: string
}) {
  const { t } = useTranslation('modsSmart')
  const text = useSmartText(name, identity)
  if (!insight || !isShownKind(insight.kind)) return null
  const label = text.kindLabel(insight.kind)
  const needed = (insight.kind === 'library' || insight.kind === 'framework') && insight.dependents > 0
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Not a tab stop (one per row would be hundreds): the same reasons
            are in "Why is it here?" and the item's details. */}
        <span
          className={cn(
            'inline-flex h-5 shrink-0 cursor-help items-center gap-1 rounded border px-1.5 text-[10px] font-medium leading-none text-foreground',
            KIND_TONE[insight.kind],
            className,
          )}
        >
          {label}
          {showDependents && needed && <span className="tabular-nums text-muted-foreground">· {insight.dependents}</span>}
          <span className="sr-only">
            {needed ? `, ${t('neededBy', { count: insight.dependents })}` : ''}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 text-xs">
        <p className="font-medium">
          {label} · {t(`confidence.${insight.kindConfidence}`)}
        </p>
        {needed && <p>{t('neededBy', { count: insight.dependents })}</p>}
        <ul className="list-disc space-y-0.5 ps-4 text-muted-foreground">
          {insight.kindReasons.slice(0, 4).map((reason, i) => (
            <li key={i}>{text.kindReasonText(reason)}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
})
