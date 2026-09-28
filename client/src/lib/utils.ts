import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Bare twMerge has no idea `justify-safe-center` (client/src/index.css --
// a hand-written fallback for justify-content: safe center, since this
// Tailwind version's justifyContent corePlugin has no arbitrary-value
// support) belongs to the same conflict group as the real `justify-*`
// classes it's meant to be overridable by. Without this, cn("justify-safe-
// center", "justify-start") lets BOTH classes reach the element instead of
// dropping the first -- the override then only wins if it happens to sit
// later in the compiled stylesheet than the base class, which is a source-
// order accident, not a guarantee (bughunt-2026-08-31: it didn't, on
// Debug.tsx's own TabsList -- the base class sat later and silently won,
// reproducing the exact overflow bug the override existed to prevent).
// Registering it here makes an explicit `justify-*` override always win at
// merge time, the way Tailwind's own conflicting classes do.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "justify-content": ["justify-safe-center"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

type DurationUnit = 'day' | 'hour' | 'minute' | 'second'
const ENGLISH_UNIT_LETTERS: Record<DurationUnit, string> = { day: 'd', hour: 'h', minute: 'm', second: 's' }

// With a `locale`, the unit letters are CLDR's narrow units through Intl --
// "3j 4h 12min" in French, "3天 4小时" in Chinese -- instead of English
// d/h/m/s dropped into a translated sentence. English's own narrow units
// are exactly d/h/m/s, and a UI language the runtime's ICU doesn't know
// (Haitian Creole) falls back to English, i.e. to what this always printed.
// Latin digits either way, matching every other number in the UI.
function unitFormatter(locale: string | undefined): (value: number, unit: DurationUnit) => string {
  const english = (value: number, unit: DurationUnit) => `${value}${ENGLISH_UNIT_LETTERS[unit]}`
  if (!locale) return english
  return (value, unit) => {
    try {
      return new Intl.NumberFormat([locale, 'en'], {
        style: 'unit', unit, unitDisplay: 'narrow', numberingSystem: 'latn',
      }).format(value)
    } catch {
      return english(value, unit)
    }
  }
}

export function formatUptime(seconds: number, locale?: string): string {
  const unit = unitFormatter(locale)
  if (!seconds || seconds < 0) return unit(0, 'second')

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts: string[] = []
  if (days > 0) parts.push(unit(days, 'day'))
  if (hours > 0) parts.push(unit(hours, 'hour'))
  if (minutes > 0) parts.push(unit(minutes, 'minute'))
  if (secs > 0 || parts.length === 0) parts.push(unit(secs, 'second'))

  return parts.join(' ')
}

/**
 * Copy text to clipboard with fallback for non-secure contexts (HTTP over LAN).
 * navigator.clipboard requires HTTPS or localhost; this falls back to execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
