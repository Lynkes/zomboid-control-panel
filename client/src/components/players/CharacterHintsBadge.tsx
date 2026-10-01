import { useTranslation } from 'react-i18next'
import { ScanSearch } from 'lucide-react'
import { type CharacterHint, unexplainedHintCount } from '@/lib/characterApi'
import { cn } from '@/lib/utils'

// Dossier badge: how many "Worth a look" hints still need a look (hints a
// panel action explains don't count). Opens the Character tab. Nothing is
// rendered when there's nothing to look at.
export function CharacterHintsBadge({ hints, onOpen }: { hints: CharacterHint[] | undefined; onOpen: () => void }) {
  const { t } = useTranslation('players')
  const count = unexplainedHintCount(hints)
  if (count === 0) return null
  const strong = (hints ?? []).some((hint) => hint.weight === 'strong' && !(hint.explainedBy && hint.explainedBy.length > 0))
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${t('character.hints.badge', { count })}. ${t('character.hints.badgeAria')}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        strong
          ? 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/20'
          : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/60',
      )}
    >
      <ScanSearch className="h-3 w-3" aria-hidden="true" />
      {t('character.hints.badge', { count })}
    </button>
  )
}
