import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectInitialLanguage, LANGUAGE_STORAGE_KEY } from '@/i18n'

// 4666849b (2026-09-01) rewrote browser-language detection to exact-match
// the full tag plus a zh-* special case, replacing the old
// navigator.language.slice(0,2) prefix match. The Chinese fix was real and
// correct, but the rewrite silently dropped bare-subtag matching for every
// OTHER language: a browser reporting only a region-qualified tag (fr-FR,
// de-DE, es-ES, ht-HT, or a real ar-PS/ar-EG/ar-SA once Arabic lands) with
// no bare subtag anywhere in navigator.languages fell straight through to
// English -- silent, first-run, no error. Restored as a second-pass
// fallback in detectInitialLanguage() so the newer exact/zh behaviour
// still wins wherever it applies.

function mockNavigatorLanguages(language: string, languages: string[] = [language]) {
  Object.defineProperty(navigator, 'language', { value: language, configurable: true })
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true })
}

describe('detectInitialLanguage -- bare-subtag fallback', () => {
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

  it('resolves fr-FR alone (no bare fr anywhere in navigator.languages) to fr -- the reported regression', () => {
    mockNavigatorLanguages('fr-FR')
    expect(detectInitialLanguage()).toBe('fr')
  })

  it('resolves de-DE alone to de', () => {
    mockNavigatorLanguages('de-DE')
    expect(detectInitialLanguage()).toBe('de')
  })

  it('resolves es-ES alone to es', () => {
    mockNavigatorLanguages('es-ES')
    expect(detectInitialLanguage()).toBe('es')
  })

  it('still exact-matches zh-Hant-TW to zh-TW (the actual Chinese fix, unregressed)', () => {
    mockNavigatorLanguages('zh-Hant-TW')
    expect(detectInitialLanguage()).toBe('zh-TW')
  })

  it('still exact-matches an already-bare supported code (zh-CN) directly', () => {
    mockNavigatorLanguages('zh-CN')
    expect(detectInitialLanguage()).toBe('zh-CN')
  })

  it('prefers an exact/zh match over a later bare-subtag match across candidates', () => {
    mockNavigatorLanguages('zh-Hant-TW', ['zh-Hant-TW', 'en'])
    expect(detectInitialLanguage()).toBe('zh-TW')
  })

  it('falls back to English when nothing -- exact, zh, or bare -- matches any candidate', () => {
    mockNavigatorLanguages('ja-JP', ['ja-JP', 'ko-KR'])
    expect(detectInitialLanguage()).toBe('en')
  })

  it('a stored language in localStorage still wins over navigator entirely', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de')
    mockNavigatorLanguages('fr-FR')
    expect(detectInitialLanguage()).toBe('de')
  })
})

// pt-BR is the only Portuguese locale, and unlike fr/de/es its registered
// code is region-qualified, so the bare-subtag fallback above can never
// reach it ('pt' is not a registered code). mapBrowserLanguage() special-
// cases every Portuguese tag onto it in the first pass, like zh-*.
describe('detectInitialLanguage -- Portuguese resolves to pt-BR', () => {
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

  it('exact-matches pt-BR', () => {
    mockNavigatorLanguages('pt-BR')
    expect(detectInitialLanguage()).toBe('pt-BR')
  })

  it.each(['pt', 'pt-PT', 'pt-AO', 'pt-MZ', 'pt-CV'])('resolves %s to pt-BR', (tag) => {
    mockNavigatorLanguages(tag)
    expect(detectInitialLanguage()).toBe('pt-BR')
  })

  it.each(['pt_BR', 'pt-br', 'PT-BR', 'pt_PT', ' pt-BR '])(
    'resolves the non-canonical spelling %j to pt-BR',
    (tag) => {
      mockNavigatorLanguages(tag)
      expect(detectInitialLanguage()).toBe('pt-BR')
    },
  )

  it('picks pt-BR for a Portugal browser list before its English fallback entries', () => {
    // Without the first-pass special case, pass 1 finds nothing for pt-PT or
    // pt, matches the exact 'en' further down, and never reaches pass 2.
    mockNavigatorLanguages('pt-PT', ['pt-PT', 'pt', 'en-US', 'en'])
    expect(detectInitialLanguage()).toBe('pt-BR')
  })

  it('keeps first-pass candidate order: an earlier exact match still wins over a later Portuguese tag', () => {
    mockNavigatorLanguages('fr', ['fr', 'pt-PT'])
    expect(detectInitialLanguage()).toBe('fr')
  })

  it('does not treat another language whose code merely starts with "pt" as Portuguese', () => {
    // ISO 639-3 'ptu' (Bambam) -- no hyphen after "pt", so not a pt-* tag.
    mockNavigatorLanguages('ptu')
    expect(detectInitialLanguage()).toBe('en')
  })

  it('a stored pt-BR preference wins over a non-Portuguese browser language', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'pt-BR')
    mockNavigatorLanguages('en-US')
    expect(detectInitialLanguage()).toBe('pt-BR')
  })
})
