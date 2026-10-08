import { useMemo, useSyncExternalStore } from 'react'
import i18n from '@/i18n'

// Every date the panel shows goes through here, so one choice in
// Settings > General > Appearance applies everywhere and a date never shows
// two ways. The UI language codes carry no region ('en', not 'en-GB'), so
// formatting with the language alone gave every English-UI user the US
// order: Automatic now adds the browser's region, and the explicit orders
// cover everyone else. Per browser, like the theme and the language.

export type DateFormatPref = 'auto' | 'dmy' | 'mdy' | 'ymd'

export const DATE_FORMAT_PREFS: readonly DateFormatPref[] = ['auto', 'dmy', 'mdy', 'ymd']

export const DATE_FORMAT_STORAGE_KEY = 'zcp-date-format'

type DateInput = string | number | Date | null | undefined

interface BaseOptions {
  /** UI language to format for; defaults to the current one. */
  language?: string
  timeZone?: string
}

export interface DateOptions extends BaseOptions {
  /** Defaults to the saved preference. */
  pref?: DateFormatPref
  /** 'medium' spells the month out under Automatic; the explicit orders are always numeric. */
  style?: 'short' | 'medium'
}

export interface DateTimeOptions extends DateOptions {
  seconds?: boolean
  timeZoneName?: 'short' | 'long'
}

export interface TimeOptions extends BaseOptions {
  seconds?: boolean
  timeZoneName?: 'short' | 'long'
}

function isDateFormatPref(value: unknown): value is DateFormatPref {
  return typeof value === 'string' && (DATE_FORMAT_PREFS as readonly string[]).includes(value)
}

// Used only when this browser refuses storage, so the choice still holds
// for the session.
let fallbackPref: DateFormatPref = 'auto'
const listeners = new Set<() => void>()

export function getDateFormatPref(): DateFormatPref {
  try {
    const stored = localStorage.getItem(DATE_FORMAT_STORAGE_KEY)
    return isDateFormatPref(stored) ? stored : 'auto'
  } catch {
    return fallbackPref
  }
}

export function setDateFormatPref(pref: DateFormatPref): void {
  fallbackPref = pref
  try {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, pref)
  } catch {
    // storage unavailable: applies until reload
  }
  for (const listener of [...listeners]) listener()
}

function browserRegion(): string | undefined {
  try {
    const first = Array.isArray(navigator.languages) && navigator.languages.length > 0 ? navigator.languages[0] : navigator.language
    return first ? new Intl.Locale(first.replace(/_/g, '-')).region : undefined
  } catch {
    return undefined
  }
}

const localeCache = new Map<string, string>()

/**
 * The locale Automatic formats in: the UI language plus the region of the
 * browser's first preferred language (English UI + en-GB browser → en-GB,
 * day/month/year; + en-US → unchanged). UI codes that already name a region
 * (zh-CN, zh-TW, pt-BR) keep it.
 */
export function getFormattingLocale(uiLanguage: string = i18n.language || 'en'): string {
  const region = browserRegion()
  const key = `${uiLanguage}|${region ?? ''}`
  let locale = localeCache.get(key)
  if (locale === undefined) {
    locale = uiLanguage
    try {
      if (region && !new Intl.Locale(uiLanguage).region) locale = new Intl.Locale(uiLanguage, { region }).toString()
    } catch {
      // not a well-formed tag: Intl falls back on its own
    }
    localeCache.set(key, locale)
  }
  return locale
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function buildFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options)
  } catch {
    // an unknown locale, or a time zone this browser lacks
  }
  try {
    return new Intl.DateTimeFormat('en', options)
  } catch {
    // the zone is the problem: show the browser's own time, unlabelled
  }
  const { timeZone: _zone, timeZoneName: _label, ...rest } = options
  try {
    return new Intl.DateTimeFormat(locale, rest)
  } catch {
    return new Intl.DateTimeFormat('en', rest)
  }
}

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let cached = formatterCache.get(key)
  if (!cached) {
    cached = buildFormatter(locale, options)
    formatterCache.set(key, cached)
  }
  return cached
}

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// The explicit orders: the parts come from the formatting locale, so the
// digits match the time printed next to them (Arabic-Indic for ar-EG).
function orderedDate(date: Date, locale: string, pref: Exclude<DateFormatPref, 'auto'>, timeZone?: string): string {
  const parts = formatter(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const day = part('day')
  const month = part('month')
  const year = part('year')
  if (pref === 'dmy') return `${day}/${month}/${year}`
  if (pref === 'mdy') return `${month}/${day}/${year}`
  return `${year}-${month}-${day}`
}

function timeOptions(options: TimeOptions): Intl.DateTimeFormatOptions {
  return {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
    timeZone: options.timeZone,
    ...(options.timeZoneName ? { timeZoneName: options.timeZoneName } : {}),
  }
}

function formatDateIn(locale: string, pref: DateFormatPref, value: DateInput, options: DateOptions): string {
  const date = toDate(value)
  if (!date) return ''
  if (pref !== 'auto') return orderedDate(date, locale, pref, options.timeZone)
  const style: Intl.DateTimeFormatOptions = options.style === 'medium'
    ? { dateStyle: 'medium' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }
  return formatter(locale, { ...style, timeZone: options.timeZone }).format(date)
}

function formatDateTimeIn(locale: string, pref: DateFormatPref, value: DateInput, options: DateTimeOptions): string {
  const date = toDate(value)
  if (!date) return ''
  if (pref !== 'auto') {
    return `${orderedDate(date, locale, pref, options.timeZone)} ${formatter(locale, timeOptions(options)).format(date)}`
  }
  // Intl refuses timeZoneName next to dateStyle/timeStyle, so a labelled
  // medium date is spelled out field by field.
  if (options.style === 'medium' && !options.timeZoneName) {
    return formatter(locale, {
      dateStyle: 'medium',
      timeStyle: options.seconds ? 'medium' : 'short',
      timeZone: options.timeZone,
    }).format(date)
  }
  const dateFields: Intl.DateTimeFormatOptions = options.style === 'medium'
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }
  return formatter(locale, { ...dateFields, ...timeOptions(options) }).format(date)
}

function formatTimeIn(locale: string, value: DateInput, options: TimeOptions): string {
  const date = toDate(value)
  if (!date) return ''
  return formatter(locale, timeOptions(options)).format(date)
}

/** A date without the time, in the saved order; '' for a missing or invalid value. */
export function formatDate(value: DateInput, options: DateOptions = {}): string {
  return formatDateIn(getFormattingLocale(options.language), options.pref ?? getDateFormatPref(), value, options)
}

/** A date and time, in the saved order; '' for a missing or invalid value. */
export function formatDateTime(value: DateInput, options: DateTimeOptions = {}): string {
  return formatDateTimeIn(getFormattingLocale(options.language), options.pref ?? getDateFormatPref(), value, options)
}

/** A time of day in the formatting locale; '' for a missing or invalid value. */
export function formatTime(value: DateInput, options: TimeOptions = {}): string {
  return formatTimeIn(getFormattingLocale(options.language), value, options)
}

export interface DateFormatter {
  pref: DateFormatPref
  locale: string
  formatDate: (value: DateInput, options?: DateOptions) => string
  formatDateTime: (value: DateInput, options?: DateTimeOptions) => string
  formatTime: (value: DateInput, options?: TimeOptions) => string
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab changing the choice, the browser's languages changing, and
  // the UI language switching all change what a date looks like.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DATE_FORMAT_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('languagechange', listener)
  i18n.on('languageChanged', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('languagechange', listener)
    i18n.off('languageChanged', listener)
  }
}

function snapshot(): string {
  return `${getDateFormatPref()}|${getFormattingLocale()}`
}

/**
 * The formatters bound to the saved preference and the current language.
 * The component re-renders when either changes, so dates on screen follow
 * the Settings select at once.
 */
export function useDateFormat(): DateFormatter {
  const key = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => {
    const [pref, locale] = key.split('|') as [DateFormatPref, string]
    return {
      pref,
      locale,
      formatDate: (value, options = {}) => formatDateIn(options.language ? getFormattingLocale(options.language) : locale, options.pref ?? pref, value, options),
      formatDateTime: (value, options = {}) => formatDateTimeIn(options.language ? getFormattingLocale(options.language) : locale, options.pref ?? pref, value, options),
      formatTime: (value, options = {}) => formatTimeIn(options.language ? getFormattingLocale(options.language) : locale, value, options),
    }
  }, [key])
}
