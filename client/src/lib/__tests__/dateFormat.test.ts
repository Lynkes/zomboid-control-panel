import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import i18n from '@/i18n'
import {
  DATE_FORMAT_STORAGE_KEY,
  formatDate,
  formatDateTime,
  formatTime,
  getDateFormatPref,
  getFormattingLocale,
  setDateFormatPref,
  useDateFormat,
} from '../dateFormat'

// 4 March, local time: a day/month swap shows, and the browser's own zone
// doesn't matter.
const MARCH_4 = new Date(2026, 2, 4, 10, 7, 5)

function browserLanguages(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
}

// The right-to-left mark Arabic puts before each date separator.
const RLM = String.fromCharCode(0x200f)

// '04/03' in the digits the panel prints its counts and sizes with for a UI
// language.
function panelDigits(text: string, language: string): string {
  return text.replace(/[0-9]/g, (d) => Number(d).toLocaleString(language))
}

afterEach(async () => {
  vi.restoreAllMocks()
  setDateFormatPref('auto')
  localStorage.removeItem(DATE_FORMAT_STORAGE_KEY)
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('the date format preference', () => {
  it('defaults to Automatic and saves a choice per browser', () => {
    expect(getDateFormatPref()).toBe('auto')
    setDateFormatPref('dmy')
    expect(localStorage.getItem(DATE_FORMAT_STORAGE_KEY)).toBe('dmy')
    expect(getDateFormatPref()).toBe('dmy')
  })

  it('ignores a value it does not know', () => {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, 'dd.mm.yyyy')
    expect(getDateFormatPref()).toBe('auto')
  })

  it('falls back to Automatic when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(getDateFormatPref()).toBe('auto')
    expect(formatDate(MARCH_4, { language: 'en' })).not.toBe('')
  })

  it('keeps a choice for the session when storage reads but will not save', () => {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, 'mdy')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    setDateFormatPref('ymd')
    expect(getDateFormatPref()).toBe('ymd')
    vi.restoreAllMocks()
    // a later save that works hands the choice back to storage
    setDateFormatPref('dmy')
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, 'mdy')
    expect(getDateFormatPref()).toBe('mdy')
  })

  it('keeps a choice for the session when storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    setDateFormatPref('ymd')
    expect(getDateFormatPref()).toBe('ymd')
  })
})

describe('explicit orders', () => {
  it('put day, month and year in the chosen order', () => {
    browserLanguages(['en-US'])
    expect(formatDate(MARCH_4, { pref: 'dmy' })).toBe('04/03/2026')
    expect(formatDate(MARCH_4, { pref: 'mdy' })).toBe('03/04/2026')
    expect(formatDate(MARCH_4, { pref: 'ymd' })).toBe('2026-03-04')
  })

  it('use the saved preference when none is passed', () => {
    browserLanguages(['en-US'])
    setDateFormatPref('dmy')
    expect(formatDate(MARCH_4)).toBe('04/03/2026')
    expect(formatDateTime(MARCH_4)).toBe('04/03/2026 10:07 AM')
  })

  it("keep the locale's own time, and go numeric for a medium date", () => {
    browserLanguages(['en-US'])
    expect(formatDateTime(MARCH_4, { pref: 'dmy', seconds: true })).toBe('04/03/2026 10:07:05 AM')
    expect(formatDateTime(MARCH_4, { pref: 'ymd', style: 'medium' })).toBe('2026-03-04 10:07 AM')
    expect(formatDateTime(MARCH_4, { language: 'de', pref: 'mdy' })).toBe('03/04/2026 10:07')
  })

  it("use the panel's digits for an Arabic UI, whatever the browser's region", () => {
    browserLanguages(['ar-EG'])
    expect(getFormattingLocale('ar')).toBe('ar-EG-u-nu-latn')
    const text = formatDateTime(MARCH_4, { language: 'ar', pref: 'dmy' })
    expect(text.startsWith(panelDigits(`04${RLM}/03${RLM}/2026 `, 'ar'))).toBe(true)
    expect(text).toContain(panelDigits('10:07', 'ar'))
    expect(formatDate(MARCH_4, { language: 'ar' })).toContain(panelDigits('2026', 'ar'))
  })

  it("keep Arabic's right-to-left marks so the date reads in order in RTL text", () => {
    browserLanguages(['ar'])
    expect(formatDate(MARCH_4, { language: 'ar', pref: 'dmy' })).toBe(panelDigits(`04${RLM}/03${RLM}/2026`, 'ar'))
    expect(formatDate(MARCH_4, { language: 'ar', pref: 'mdy' })).toBe(panelDigits(`03${RLM}/04${RLM}/2026`, 'ar'))
    expect(formatDate(MARCH_4, { language: 'ar', pref: 'ymd' })).toBe(panelDigits(`2026${RLM}-03${RLM}-04`, 'ar'))
    expect(formatDate(MARCH_4, { language: 'en', pref: 'dmy' })).not.toContain(RLM)
    expect(formatDate(MARCH_4, { language: 'en', pref: 'ymd' })).not.toContain(RLM)
  })
})

describe('Automatic', () => {
  it('keeps the US order for an English UI in an en-US browser', () => {
    browserLanguages(['en-US', 'en'])
    expect(getFormattingLocale('en')).toBe('en-US')
    expect(formatDate(MARCH_4)).toBe('3/4/2026')
    expect(formatDateTime(MARCH_4)).toBe('3/4/2026, 10:07 AM')
    expect(formatDateTime(MARCH_4, { seconds: true })).toBe('3/4/2026, 10:07:05 AM')
    expect(formatDateTime(MARCH_4, { style: 'medium' })).toBe('Mar 4, 2026, 10:07 AM')
  })

  it("follows the browser's region: an English UI in an en-GB browser gets day/month/year", () => {
    browserLanguages(['en-GB', 'en'])
    expect(getFormattingLocale('en')).toBe('en-GB')
    expect(formatDate(MARCH_4)).toBe('04/03/2026')
    expect(formatDateTime(MARCH_4)).toBe('04/03/2026, 10:07')
  })

  it('takes the region from any language the browser lists first', () => {
    browserLanguages(['de-DE', 'en'])
    expect(getFormattingLocale('en')).toBe('en-DE')
    expect(formatDate(MARCH_4, { language: 'en' })).toBe('04/03/2026')
  })

  it('leaves the UI language alone when the browser names no region', () => {
    browserLanguages(['en'])
    expect(getFormattingLocale('en')).toBe('en')
    expect(formatDate(MARCH_4)).toBe('3/4/2026')
  })

  it('keeps the region a UI language already has', () => {
    browserLanguages(['en-GB'])
    expect(getFormattingLocale('zh-CN')).toBe('zh-CN')
    expect(getFormattingLocale('zh-TW')).toBe('zh-TW')
    expect(getFormattingLocale('pt-BR')).toBe('pt-BR')
    expect(formatDate(MARCH_4, { language: 'zh-CN' })).toBe('2026/3/4')
  })
})

describe('time zones', () => {
  const LATE_UTC = '2026-03-04T22:30:00.000Z'

  it('formats in the given zone and labels it', () => {
    browserLanguages(['en-US'])
    expect(formatDateTime(LATE_UTC, { style: 'medium', timeZone: 'UTC', timeZoneName: 'short' })).toBe('Mar 4, 2026, 10:30 PM UTC')
    expect(formatDateTime(LATE_UTC, { style: 'medium', timeZone: 'Asia/Tokyo', timeZoneName: 'short' })).toBe('Mar 5, 2026, 7:30 AM GMT+9')
  })

  it('moves the date itself into the zone under an explicit order', () => {
    browserLanguages(['en-US'])
    expect(formatDateTime(LATE_UTC, { pref: 'dmy', timeZone: 'Asia/Tokyo', timeZoneName: 'short' })).toBe('05/03/2026 7:30 AM GMT+9')
  })

  it("falls back to the browser's own zone for one Intl doesn't know", () => {
    browserLanguages(['en-US'])
    expect(formatDateTime(LATE_UTC, { timeZone: 'Not/AZone', timeZoneName: 'short' })).toBe(formatDateTime(LATE_UTC))
  })
})

describe('times', () => {
  it('format a time of day in the formatting locale', () => {
    browserLanguages(['en-US'])
    expect(formatTime(MARCH_4)).toBe('10:07 AM')
    expect(formatTime(MARCH_4, { seconds: true })).toBe('10:07:05 AM')
    browserLanguages(['en-GB'])
    expect(formatTime(MARCH_4, { language: 'en' })).toBe('10:07')
  })

  it('pad the hour to two digits for a fixed-width column', () => {
    const MORNING = new Date(2026, 2, 4, 9, 7, 5)
    browserLanguages(['en-US'])
    expect(formatTime(MORNING)).toBe('9:07 AM')
    expect(formatTime(MORNING, { pad: true })).toBe('09:07 AM')
    expect(formatTime(MORNING, { pad: true, seconds: true })).toBe('09:07:05 AM')
    browserLanguages(['en-GB'])
    expect(formatTime(MORNING, { language: 'en', pad: true })).toBe('09:07')
  })
})

describe('missing or invalid input', () => {
  it.each([null, undefined, '', 'not a date', Number.NaN, new Date('nope')])('%s gives an empty string', (value) => {
    expect(formatDate(value)).toBe('')
    expect(formatDateTime(value)).toBe('')
    expect(formatTime(value)).toBe('')
  })
})

describe('useDateFormat', () => {
  it('re-renders with the new order when the preference changes', () => {
    browserLanguages(['en-US'])
    const { result } = renderHook(() => useDateFormat())
    expect(result.current.pref).toBe('auto')
    expect(result.current.formatDate(MARCH_4)).toBe('3/4/2026')
    act(() => setDateFormatPref('dmy'))
    expect(result.current.pref).toBe('dmy')
    expect(result.current.formatDate(MARCH_4)).toBe('04/03/2026')
  })

  it('follows a UI language change', async () => {
    browserLanguages(['en-US'])
    const { result } = renderHook(() => useDateFormat())
    await act(async () => {
      await i18n.changeLanguage('de')
    })
    expect(result.current.formatDate(MARCH_4)).toBe('4.3.2026')
  })
})
