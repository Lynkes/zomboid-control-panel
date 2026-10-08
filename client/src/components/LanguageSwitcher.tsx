import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getCurrentLanguage, setLanguage, OFFERED_LANGUAGES } from '@/i18n'

// The persisted locale switcher — its options come entirely from the
// LANGUAGES registry (client/src/i18n/languages.ts; hidden rows are
// skipped via OFFERED_LANGUAGES), so adding a language
// there is the only change needed for it to show up here. Language names
// are each language's OWN native name (Deutsch, not German), read straight
// from the registry rather than through t() — see languages.ts for why.
// Usable pre-login (Login/Setup) and from the app shell footer.
// `compact` is icon-only, for the sidebar footer's toolbar and icon rail,
// where every control is the same square; the caller passes that box via
// className. The accessible name and the title still carry the native name,
// and the menu lists native names either way.
export function LanguageSwitcher({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation('shell')
  const current = getCurrentLanguage()
  const currentLanguage = OFFERED_LANGUAGES.find((l) => l.code === current) ?? OFFERED_LANGUAGES[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            !compact && 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
          aria-label={`${t('languageSwitcher.label')}: ${currentLanguage.nativeName}`}
          title={compact ? currentLanguage.nativeName : undefined}
        >
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          {!compact && <span>{currentLanguage.nativeName}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Radio items, so a screen reader says "checked" for the active
            language; lang= so each native name is read in its own voice. */}
        <DropdownMenuRadioGroup value={current} onValueChange={setLanguage}>
          {OFFERED_LANGUAGES.map((lang) => (
            <DropdownMenuRadioItem key={lang.code} value={lang.code}>
              <span lang={lang.code}>{lang.nativeName}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
