import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ToolbarSearch {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  inputRef?: RefObject<HTMLInputElement | null>
  /** Press `/` anywhere on the page (outside a field or dialog) to focus the search. */
  slashToFocus?: boolean
}

export interface ToolbarProps {
  search?: ToolbarSearch
  /** Filters: Segmented, Selects, toggles. */
  children?: ReactNode
  /** Pushed to the far end: view switches, a "More" menu, counts. */
  end?: ReactNode
  /** Sticks to the top of the scrolling page. */
  sticky?: boolean
  className?: string
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable
}

/** The row above a list: search first, then filters, then end-aligned extras. */
export function Toolbar({ search, children, end, sticky, className }: ToolbarProps) {
  const { t } = useTranslation('shell')
  const ownRef = useRef<HTMLInputElement>(null)
  const inputRef = search?.inputRef ?? ownRef
  const slashToFocus = !!search?.slashToFocus

  useEffect(() => {
    if (!slashToFocus) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.defaultPrevented || isTypingTarget(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [slashToFocus, inputRef])

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        sticky && 'sticky top-0 z-20 -mx-1 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80',
        className,
      )}
    >
      {search && (
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef as RefObject<HTMLInputElement>}
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              if (search.value) {
                event.preventDefault()
                search.onChange('')
              } else {
                event.currentTarget.blur()
              }
            }}
            placeholder={search.placeholder}
            aria-label={search.ariaLabel}
            aria-keyshortcuts={search.slashToFocus ? '/' : undefined}
            className="flex h-11 w-full rounded-md border border-input bg-input pe-9 ps-8 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-9 md:text-sm [&::-webkit-search-cancel-button]:hidden"
          />
          {search.value ? (
            <button
              type="button"
              onClick={() => {
                search.onChange('')
                inputRef.current?.focus()
              }}
              aria-label={t('toolbar.clearSearch')}
              className="absolute end-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : (
            search.slashToFocus && (
              <kbd
                aria-hidden="true"
                className="pointer-events-none absolute end-2 top-1/2 hidden -translate-y-1/2 rounded border border-border/60 px-1.5 font-mono text-micro text-muted-foreground sm:inline-block"
              >
                /
              </kbd>
            )
          )}
        </div>
      )}
      {children}
      {end && <div className="ms-auto flex flex-wrap items-center gap-2">{end}</div>}
    </div>
  )
}
