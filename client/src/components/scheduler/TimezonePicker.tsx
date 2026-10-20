import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Search, SearchX } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// Timezone picker's candidate pool (2026-08-31, whitespace/picker card).
// Intl.supportedValuesOf('timeZone') is deliberately NOT the sole source of
// truth here -- server/utils/cronValidation.js's isValidIanaTimezone()
// already documents that this canonical list is narrower than what
// Intl.DateTimeFormat (and therefore node-cron) actually accepts, and
// omits some valid legacy/alias names real installs use. Confirmed
// concretely: 'UTC' itself -- the exact fallback value this page's own
// status object reports and the server's own invalid-timezone error message
// cites as an example -- is NOT in supportedValuesOf()'s output. Prepended
// by hand rather than pulled from a second Intl call so the gap is explicit
// and doesn't silently reappear if ICU data changes again. Computed once at
// module load, not per-render or per-mount.
//
// Typed via a local cast, not a tsconfig "lib" bump: this project's ts
// target (ES2020) predates the ES2022 Intl types that declare
// supportedValuesOf, but the method itself has shipped in every real engine
// (Node 18+, all evergreen browsers) since well before that -- a runtime
// feature gap, not a real absence, so a narrow cast here is more honest than
// widening "lib" project-wide for one call site.
type IntlWithSupportedValuesOf = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[]
}

const TIMEZONE_POOL: string[] = (() => {
  let canonical: string[] = []
  try {
    const supportedValuesOf = (Intl as IntlWithSupportedValuesOf).supportedValuesOf
    if (typeof supportedValuesOf === 'function') {
      canonical = supportedValuesOf('timeZone')
    }
  } catch {
    // Unsupported engine (pre-2022 Safari, etc.) -- degrade to just the
    // hand-picked entries below rather than crashing the whole page.
  }
  return Array.from(new Set(['UTC', ...canonical]))
})()

// Groups by the IANA area prefix ("America/New_York" -> "America"). A zone
// with no "/" (currently only the hand-added 'UTC') becomes its own
// single-entry group labeled with the zone name itself.
function timezoneGroup(zone: string): string {
  const slash = zone.indexOf('/')
  return slash === -1 ? zone : zone.slice(0, slash).replace(/_/g, ' ')
}

interface TimezonePickerProps {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

// Searchable timezone combobox. Deliberately built on a single always-
// present <input> (not a separate closed-trigger + hidden-search-input
// split like ItemPicker/VehiclePicker) so the input's value IS the
// committed value at every moment -- typing both filters the dropdown AND
// sets the real value, so a saved zone that isn't in TIMEZONE_POOL (a
// dropped legacy name, or this panel restored from another machine) is
// still shown verbatim rather than getting silently blanked or reset.
export function TimezonePicker({ id, value, onChange, disabled }: TimezonePickerProps) {
  const { t } = useTranslation('scheduler')
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)
  // Opening on a field that already has a saved value (the normal case --
  // this field is seeded from the operator's current zone) must NOT filter
  // the dropdown down to just that one self-match; a "choice picker" needs
  // to show every choice on open. Only real typing narrows the list --
  // false again on every fresh open, so clicking away and back re-browses
  // the full set instead of staying pinned to whatever was last typed.
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => { setHighlightIndex(-1) }, [value, open])

  useEffect(() => {
    if (!open || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setDropUp(window.innerHeight - rect.bottom < 320)
  }, [open])

  const query = searching ? value.trim().toLowerCase().replace(/_/g, ' ') : ''
  const { visible, grouped } = useMemo(() => {
    if (!query) {
      const groups = new Map<string, string[]>()
      for (const zone of TIMEZONE_POOL) {
        const g = timezoneGroup(zone)
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(zone)
      }
      for (const list of groups.values()) list.sort((a, b) => a.localeCompare(b))
      const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) =>
        a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)
      )
      return { visible: sortedGroups.flatMap(([, zones]) => zones), grouped: sortedGroups }
    }
    const filtered = TIMEZONE_POOL
      .filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(query))
      .sort((a, b) => a.localeCompare(b))
    return { visible: filtered, grouped: null as [string, string[]][] | null }
  }, [query])

  const handleSelect = (zone: string) => {
    onChange(zone)
    setOpen(false)
    setHighlightIndex(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex((prev) => Math.min(prev + 1, visible.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        // No fallback to "select the first visible item" on a bare Enter --
        // unlike ItemPicker/VehiclePicker, a value that isn't in the pool is
        // a legitimate outcome here, so an un-highlighted Enter just keeps
        // whatever was typed instead of silently substituting a guess.
        if (highlightIndex >= 0 && highlightIndex < visible.length) {
          e.preventDefault()
          handleSelect(visible[highlightIndex])
        }
        break
      case 'Escape':
        setOpen(false)
        setHighlightIndex(-1)
        break
    }
  }

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-tz-index="${highlightIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  const renderOption = (zone: string) => {
    const idx = visible.indexOf(zone)
    return (
      <button
        key={zone}
        type="button"
        role="option"
        id={`${id}-opt-${idx}`}
        aria-selected={zone === value}
        data-tz-index={idx}
        onClick={() => handleSelect(zone)}
        className={cn(
          'w-full px-3 py-1.5 text-start text-xs font-mono truncate motion-safe:transition-colors',
          'hover:bg-accent/10',
          zone === value && 'bg-primary/10 text-primary',
          idx === highlightIndex && 'bg-accent/15'
        )}
      >
        {zone}
      </button>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" aria-hidden="true" />
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={open && highlightIndex >= 0 && visible[highlightIndex] ? `${id}-opt-${highlightIndex}` : undefined}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setSearching(true) }}
          onFocus={(e) => { setOpen(true); setSearching(false); e.target.select() }}
          onKeyDown={handleKeyDown}
          placeholder="America/New_York"
          className="font-mono ps-8 pe-8"
          maxLength={100}
          disabled={disabled}
          autoComplete="off"
        />
        <ChevronDown
          className={cn(
            'pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 motion-safe:transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </div>
      {open && !disabled && (
        <div
          className={cn(
            'absolute z-50 w-full min-w-[260px] rounded-md border border-border bg-popover shadow-lg',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          )}
        >
          <div
            ref={listRef}
            role="listbox"
            id={`${id}-listbox`}
            aria-label={t('timezone.inputLabel')}
            className="max-h-64 overflow-y-auto overscroll-contain py-1"
          >
            {visible.length === 0 ? (
              <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                <SearchX className="w-3.5 h-3.5 shrink-0 opacity-50" aria-hidden="true" />
                {t('timezone.noMatches')}
              </p>
            ) : grouped ? (
              grouped.map(([group, zones]) => (
                <div key={group}>
                  {/* Skip the header for a single-entry group whose only
                      zone IS the group label (currently just 'UTC') --
                      showing "UTC" as both a section header and the one
                      option under it is a redundant, not a clarifying, line. */}
                  {!(zones.length === 1 && zones[0] === group) && (
                    <div className="sticky top-0 z-10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 bg-muted/70 backdrop-blur-sm">
                      {group}
                    </div>
                  )}
                  {zones.map(renderOption)}
                </div>
              ))
            ) : (
              visible.map(renderOption)
            )}
          </div>
        </div>
      )}
    </div>
  )
}
