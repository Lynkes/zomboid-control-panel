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

export type DurationUnit = 'day' | 'hour' | 'minute' | 'second'

// A duration as formatUptime() prints it -- its non-zero units from days
// down to seconds, or 0 seconds -- for a caller that words each unit itself:
// ServerUptime takes them from its locale file, where translators own the
// abbreviations ("3 Tg." in German, "3 дн" in Ukrainian), as they do for
// every other duration in the UI.
export function splitUptime(seconds: number): Array<{ unit: DurationUnit; count: number }> {
  if (!seconds || seconds < 0) return [{ unit: 'second', count: 0 }]

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts: Array<{ unit: DurationUnit; count: number }> = []
  if (days > 0) parts.push({ unit: 'day', count: days })
  if (hours > 0) parts.push({ unit: 'hour', count: hours })
  if (minutes > 0) parts.push({ unit: 'minute', count: minutes })
  if (secs > 0 || parts.length === 0) parts.push({ unit: 'second', count: secs })
  return parts
}

const UNIT_LETTERS: Record<DurationUnit, string> = { day: 'd', hour: 'h', minute: 'm', second: 's' }

export function formatUptime(seconds: number): string {
  return splitUptime(seconds).map(({ unit, count }) => `${count}${UNIT_LETTERS[unit]}`).join(' ')
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
