import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Lightbulb, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import type { ModGroupSuggestion } from '@/lib/api'
import { GROUP_NAME_MAX } from '@/lib/modGroups'
import { useLocalStorageState } from '@/lib/modsShared'

export interface GroupSuggestionsProps {
  suggestions: readonly ModGroupSuggestion[]
  modNames: Readonly<Record<string, string>>
  canManage: boolean
  /** Opens the group dialog pre-filled with the suggestion (every member, the card's title as the name). */
  onCreate: (suggestion: ModGroupSuggestion) => void
  onDismiss: (suggestion: ModGroupSuggestion) => void
  /** Remembers whether the area is open, per place it is shown. */
  storageKey: string
}

const NAMES_SHOWN = 3

/**
 * "Suggestions (n)": groups the panel found in the server's mods (a library
 * and the mods needing it, mods sharing a name prefix, a Workshop item that
 * ships several mods), each with its members one per line ("Show all N mods"
 * past the first few), Create (opens the group dialog, editable) and Dismiss
 * (hidden for every admin).
 */
export function GroupSuggestions({ suggestions, modNames, canManage, onCreate, onDismiss, storageKey }: GroupSuggestionsProps) {
  const { t } = useTranslation('modGroups')
  const [open, setOpen] = useLocalStorageState(storageKey, true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  if (suggestions.length === 0) return null
  const reason = canManage ? null : t('panel.noPermission')
  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

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
        <ul className="grid grid-cols-1 gap-2 border-t border-border/50 p-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('suggestions.listAria')}>
          {suggestions.map((suggestion) => {
            // A library whose users are not otherwise related: "Mods that use <library>".
            const title = suggestion.library ? t('suggestions.usesTitle', { library: suggestion.library }) : suggestion.name
            const all = suggestion.modIds.map((id) => modNames[id] ?? id)
            const showAll = expanded.has(suggestion.key)
            const shown = showAll ? all : all.slice(0, NAMES_SHOWN)
            const listId = `suggestion-mods-${suggestion.key}`
            return (
              <li key={suggestion.key} className="flex flex-col gap-2 rounded-md border border-border/60 bg-card p-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium text-foreground">{title}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`suggestions.kind.${suggestion.kind}`, {
                      // A library suggestion counts the mods that need it, not the library.
                      count: suggestion.kind === 'dependency' ? Math.max(1, suggestion.dependents ?? suggestion.modIds.length - 1) : suggestion.modIds.length,
                      name: suggestion.library ?? suggestion.name,
                    })}
                  </p>
                  <ul id={listId} className="space-y-0.5 text-xs text-muted-foreground" aria-label={t('suggestions.membersAria', { name: title })}>
                    {shown.map((name, index) => (
                      <li key={`${suggestion.modIds[index]}`} className="break-words">{name}</li>
                    ))}
                  </ul>
                  {all.length > NAMES_SHOWN && (
                    <button
                      type="button"
                      aria-expanded={showAll}
                      aria-controls={listId}
                      onClick={() => toggle(suggestion.key)}
                      className="rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                    >
                      {showAll ? t('suggestions.showFewer') : t('suggestions.showAll', { n: all.length })}
                    </button>
                  )}
                </div>
                <div className="mt-auto flex items-center gap-1">
                  <DisabledReason reason={reason}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onCreate(suggestion.library ? { ...suggestion, name: title.slice(0, GROUP_NAME_MAX) } : suggestion)}
                      disabled={!canManage}
                      aria-label={t('suggestions.createAria', { name: title })}
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
                      aria-label={t('suggestions.dismissAria', { name: title })}
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
