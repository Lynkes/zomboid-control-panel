import i18n from '@/i18n'

// Byte counts for people: "12.5 MB", "٣٫٢ غ.ب" in Arabic. Intl's `unit` style
// owns the unit abbreviation and the digit shapes per language, so no
// locale file carries "KB"/"MB" strings that a translator would have to
// keep in step with the number formatting. Steps are 1024 (what file
// managers and the OS dialogs show for disk sizes).
const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

const formatterCache = new Map<string, Intl.NumberFormat>()

// 'short' spells a byte out ("258 byte" in English); 'narrow' gives "258B",
// matching "18.5 kB" next to it.
function unitDisplayFor(unit: (typeof UNITS)[number]): 'short' | 'narrow' {
  return unit === 'byte' ? 'narrow' : 'short'
}

function formatterFor(language: string, unit: (typeof UNITS)[number], fractionDigits: number): Intl.NumberFormat {
  const cacheKey = `${language}|${unit}|${fractionDigits}`
  let formatter = formatterCache.get(cacheKey)
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(language, {
        style: 'unit',
        unit,
        unitDisplay: unitDisplayFor(unit),
        maximumFractionDigits: fractionDigits,
      })
    } catch {
      // An unknown language tag throws a RangeError; English is always there.
      formatter = new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: unitDisplayFor(unit), maximumFractionDigits: fractionDigits })
    }
    formatterCache.set(cacheKey, formatter)
  }
  return formatter
}

/** `bytes` as a short, localized size; an empty string for null/negative/NaN. */
export function formatBytes(bytes: number | null | undefined, language: string = i18n.language || 'en'): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  // Whole bytes stay whole; 1.5 kB keeps one decimal; 120 MB drops it.
  const fractionDigits = unitIndex === 0 || value >= 100 ? 0 : 1
  return formatterFor(language, UNITS[unitIndex], fractionDigits).format(value)
}
