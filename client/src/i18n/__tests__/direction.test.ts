import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n, { LANGUAGE_CODES, isRTL, directionOf } from '@/i18n'
import type { LanguageDef } from '@/i18n'

// RTL support (Ukrainian/Arabic project): directionOf() is a free function
// over a LanguageDef rather than a lookup, so the RTL branch is testable
// against a synthetic fixture without needing a real RTL row in LANGUAGES
// -- there isn't one yet (that lands with the ar worker's row + a rebase).
describe('directionOf', () => {
  it('defaults to ltr when dir is absent', () => {
    const lang: LanguageDef = { code: 'xx', nativeName: 'Xx' }
    expect(directionOf(lang)).toBe('ltr')
  })

  it('defaults to ltr for an undefined language (unknown code)', () => {
    expect(directionOf(undefined)).toBe('ltr')
  })

  it('honours an explicit ltr', () => {
    const lang: LanguageDef = { code: 'xx', nativeName: 'Xx', dir: 'ltr' }
    expect(directionOf(lang)).toBe('ltr')
  })

  it('honours an explicit rtl', () => {
    const lang: LanguageDef = { code: 'xx', nativeName: 'Xx', dir: 'rtl' }
    expect(directionOf(lang)).toBe('rtl')
  })
})

describe('isRTL -- every language actually registered today (provably inert)', () => {
  // Every one of the 6 currently-registered languages must be ltr -- this
  // is the "nothing changes for the six existing locales" requirement,
  // checked against the real registry rather than assumed. If a 7th
  // (RTL) row lands later, this list intentionally does NOT grow to cover
  // it -- see the languages.test.ts denominator note for why.
  it.each(LANGUAGE_CODES)('isRTL(%s) is false', (code) => {
    expect(isRTL(code)).toBe(false)
  })

  it('is false for an unregistered code', () => {
    expect(isRTL('xx-not-a-real-language')).toBe(false)
  })
})

describe('document <html dir>/<html lang> sync on language switch', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('stays ltr and updates lang for every registered (all-LTR) language', async () => {
    for (const code of LANGUAGE_CODES) {
      await i18n.changeLanguage(code)
      expect(document.documentElement.dir).toBe('ltr')
      expect(document.documentElement.lang).toBe(code)
    }
  })
})
