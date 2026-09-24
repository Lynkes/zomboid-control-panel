import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectInitialLanguage,
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  LANGUAGE_CODES,
  OFFERED_LANGUAGES,
} from '@/i18n'

// Haitian Creole (ht) is registered and offered now that its sandbox labels
// have a complete translated value pass. Keep these checks because the
// registered/offered split is still a deliberate contract for future locales.

function mockNavigatorLanguages(language: string, languages: string[] = [language]) {
  Object.defineProperty(navigator, 'language', { value: language, configurable: true })
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true })
}

describe('offered languages (ht)', () => {
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

  it('keeps ht registered and offered after its translation pass', () => {
    expect(LANGUAGES.map((l) => l.code)).toContain('ht')
    expect(OFFERED_LANGUAGES.map((l) => l.code)).toContain('ht')
    expect(LANGUAGE_CODES).toContain('ht')
  })

  it('still offers every other registered language', () => {
    expect(OFFERED_LANGUAGES.map((l) => l.code)).toEqual(LANGUAGES.map((l) => l.code))
  })

  it('resolves a stored ht preference to ht', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ht')
    mockNavigatorLanguages('en-US')
    expect(detectInitialLanguage()).toBe('ht')
  })

  it('resolves a browser-detected ht / ht-HT to ht', () => {
    mockNavigatorLanguages('ht-HT', ['ht-HT', 'ht'])
    expect(detectInitialLanguage()).toBe('ht')
    mockNavigatorLanguages('ht')
    expect(detectInitialLanguage()).toBe('ht')
  })
})
