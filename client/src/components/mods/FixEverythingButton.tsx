import { useTranslation } from 'react-i18next'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'

/** The one primary of the Conflicts and Health views: opens "Fix everything" (useFixEverything). */
export function FixEverythingButton({ onClick, disabledReason, busy }: { onClick: () => void; disabledReason: string | null; busy: boolean }) {
  const { t } = useTranslation('modRules')
  return (
    <DisabledReason reason={disabledReason}>
      <Button variant="command" size="sm" onClick={onClick} disabled={!!disabledReason || busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
        {t('autofix.button')}
      </Button>
    </DisabledReason>
  )
}
