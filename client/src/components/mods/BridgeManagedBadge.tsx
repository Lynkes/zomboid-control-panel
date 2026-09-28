import { useTranslation } from 'react-i18next'
import { Cable } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface BridgeManagedBadgeProps {
  className?: string
}

// Marks the PanelBridge Workshop entry in the Mods page's "Active on server"
// list while the active server gets PanelBridge from the Steam Workshop
// (§4.11). The badge only explains the lock -- the real enforcement is the
// server's mods.js ini guard, which puts the entry back if anything removes
// it. The tooltip text is the same string the row's disabled toggle and
// remove controls show through DisabledReason, so hovering either says the
// same thing.
export function BridgeManagedBadge({ className }: BridgeManagedBadgeProps) {
  const { t } = useTranslation('bridgeDelivery')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary',
            className,
          )}
          aria-label={`${t('mods.badge')}: ${t('mods.badgeTooltip')}`}
        >
          <Cable className="h-3 w-3" aria-hidden="true" />
          {t('mods.badge')}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-start text-xs leading-relaxed">
        {t('mods.badgeTooltip')}
      </TooltipContent>
    </Tooltip>
  )
}
