import { useTranslation } from 'react-i18next'
import { ChevronRight, Lightbulb, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import type { ModGroupSuggestion } from '@/lib/api'
import { useLocalStorageState } from '@/lib/modsShared'

export interface GroupSuggestionsProps {
  suggestions: readonly ModGroupSuggestion[]
  modNames: Readonly<Record<string, string>>
  canManage: boolean
  /** Opens the group dialog pre-filled with the suggestion. */
  onCreate: (suggestion: ModGroupSuggestion) => void
  onDismiss: (suggestion: ModGroupSuggestion) => void
  /** Remembers whether the area is open, per place it is shown. */
  storageKey: string
}

const NAMES_SHOWN = 3

/**
 * "Suggestions (n)": groups the panel found in the server's mods (a library
 * and the mods needing it, mods sharing a name prefix, a Workshop item that
 * ships several mods), each with Create (opens the group dialog, editable) and
 * Dismiss (hidden for every admin).
 */
export function GroupSuggestions({ suggestions, modNames, canManage, onCreate, onDismiss, storageKey }: GroupSuggestionsProps) {
  const { t } = useTranslation('modGroups')
  const [open, setOpen] = useLocalStorageState(storageKey, true)
  if (suggestions.length === 0) return null
  const reason = canManage ? null : t('panel.noPermission')

  return (
    <div className="rounded-lg border border-border/60 bg-muted/25">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 rtl:-scale-x-100 ${open ? 'rotate-90 rtl:-rotate-90' : ''}`} aria-hidden="true" />
        <Lightbulb className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        {t('suggestions.title', { count: suggestions.length })}
      </button>
      {open && (
        <ul className="grid gap-2 border-t border-border/50 p-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('suggestions.listAria')}>
          {suggestions.map((suggestion) => {
            const names = suggestion.modIds.slice(0, NAMES_SHOWN).map((id) => modNames[id] ?? id)
            const more = suggestion.modIds.length - names.length
            return (
              <li key={suggestion.key} className="flex flex-col gap-2 rounded-md border border-border/60 bg-card p-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium text-foreground" title={suggestion.name}>{suggestion.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`suggestions.kind.${suggestion.kind}`, {
                      // A library suggestion counts the mods that need it, not the library.
                      count: suggestion.kind === 'dependency' ? Math.max(1, suggestion.modIds.length - 1) : suggestion.modIds.length,
                      name: suggestion.name,
                    })}
                  </p>
                  <p className="truncate text-xs text-muted-foreground" title={suggestion.modIds.map((id) => modNames[id] ?? id).join(', ')}>
                    {names.join(', ')}
                    {more > 0 ? ` ${t('panel.andMore', { n: more })}` : ''}
                  </p>
                </div>
                <div className="mt-auto flex items-center gap-1">
                  <DisabledReason reason={reason}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onCreate(suggestion)}
                      disabled={!canManage}
                      aria-label={t('suggestions.createAria', { name: suggestion.name })}
                    >
                      <Plus aria-hidden="true" />
                      {t('suggestions.create')}
                    </Button>
                  </DisabledReason>
                  <DisabledReason reason={reason}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDismiss(suggestion)}
                      disabled={!canManage}
                      aria-label={t('suggestions.dismissAria', { name: suggestion.name })}
                    >
                      <X aria-hidden="true" />
                      {t('suggestions.dismiss')}
                    </Button>
                  </DisabledReason>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
