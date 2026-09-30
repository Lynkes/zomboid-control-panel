import type { TFunction } from 'i18next'

// Locale-aware number and time formatting shared by the Character tab's
// sections. Every function returns '' for a missing or unparseable value so a
// caller can leave the field out rather than print "NaN".

export function formatNumber(value: number | undefined | null, language: string, maximumFractionDigits = 0): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  try {
    return new Intl.NumberFormat(language, { maximumFractionDigits }).format(value)
  } catch {
    return String(Math.round(value))
  }
}

function toDate(iso: string | number | undefined | null): Date | null {
  if (iso === undefined || iso === null) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** HH:MM:SS in the viewer's locale. */
export function formatTime(iso: string | number | undefined | null, language: string): string {
  const date = toDate(iso)
  if (!date) return ''
  try {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return date.toLocaleTimeString()
  }
}

/** HH:MM, for "since" chips. */
export function formatShortTime(iso: string | number | undefined | null, language: string): string {
  const date = toDate(iso)
  if (!date) return ''
  try {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return date.toLocaleTimeString()
  }
}

/** A date and time, for "saved {{when}}". */
export function formatWhen(iso: string | number | undefined | null, language: string): string {
  const date = toDate(iso)
  if (!date) return ''
  try {
    return date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return date.toLocaleString()
  }
}

/** Real hours this life has lasted, estimated from in-game time. */
export function estimatePlayedHours(hoursSurvived: number | undefined, minutesPerDay: number | undefined): number | undefined {
  if (typeof hoursSurvived !== 'number' || !Number.isFinite(hoursSurvived)) return undefined
  const perDay = typeof minutesPerDay === 'number' && minutesPerDay > 0 ? minutesPerDay : DEFAULT_MINUTES_PER_DAY
  return (hoursSurvived * perDay) / 1440
}

// The game's default day length (sandbox DayLength "1 hour").
export const DEFAULT_MINUTES_PER_DAY = 60

/**
 * "Given through the panel {when}", or "{given} of {qty} given through the
 * panel {when}" when the panel gave only part of what's carried.
 */
export function givenCopy(
  t: TFunction,
  { given, qty, givenAt }: { given?: number; qty?: number; givenAt: string },
  language: string,
): string {
  const when = formatWhen(givenAt, language)
  if (typeof given === 'number' && typeof qty === 'number' && given < qty) {
    return t('character.inventory.givenViaPanelPartial', {
      given: formatNumber(given, language),
      qty: formatNumber(qty, language),
      when,
    })
  }
  return t('character.inventory.givenViaPanel', { when })
}
