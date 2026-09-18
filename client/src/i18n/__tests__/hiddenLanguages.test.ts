import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectInitialLanguage,
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  LANGUAGE_CODES,
  OFFERED_LANGUAGES,
} from '@/i18n'

// Haitian Creole (ht) is registered -- its locale files stay in the repo and
// in the parity gates -- but hidden until it is actually translated (the
// sandbox labels were ~87% English). Hidden must mean: not offered in the
// picker, and never resolved to by a stored or browser-detected preference.

function mockNavigatorLanguages(language: string, languages: string[] = [language]) {
  Object.defineProperty(navigator, 'language', { value: language, configurable: true })
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true })
}

describe('hidden languages (ht)', () => {
  const originalLanguage = navigator.language
  const originalLanguages = navigator.languages

  beforeEach(() => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'language', { value: originalLanguage, configurable: true })
    Object.defineProperty(navigator, 'languages', { value: originalLanguages, configurable: true })
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
  })

  it('keeps ht registered (so the parity gates still cover it) but not offered', () => {
    expect(LANGUAGES.map((l) => l.code)).toContain('ht')
    expect(OFFERED_LANGUAGES.map((l) => l.code)).not.toContain('ht')
    expect(LANGUAGE_CODES).not.toContain('ht')
  })

  it('still offers every other registered language', () => {
    const offered = OFFERED_LANGUAGES.map((l) => l.code)
    expect(offered).toEqual(LANGUAGES.map((l) => l.code).filter((c) => c !== 'ht'))
    expect(offered).toContain('en')
  })

  it('resolves a stored ht preference to en', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ht')
    mockNavigatorLanguages('en-US')
    expect(detectInitialLanguage()).toBe('en')
  })

  it('resolves a browser-detected ht / ht-HT to en', () => {
    mockNavigatorLanguages('ht-HT', ['ht-HT', 'ht'])
    expect(detectInitialLanguage()).toBe('en')
    mockNavigatorLanguages('ht')
    expect(detectInitialLanguage()).toBe('en')
  })
})
