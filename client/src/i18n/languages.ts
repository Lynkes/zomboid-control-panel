// THE single place that declares which languages this panel supports.
//
// Adding a language: create client/src/locales/<code>/ with the same
// namespace files as English (see client/src/locales/README.md), then add
// one row to LANGUAGES below. i18next's resources, the LanguageSwitcher's
// menu, and the locale parity test all DERIVE from this file rather than
// naming languages of their own — nothing else should need to change.
export interface LanguageDef {
  code: string
  // Always the language's OWN name for itself (Deutsch, not German) —
  // shown in the switcher regardless of which language is currently
  // active. Deliberately not a translation key: a translated language name
  // would need adding to every OTHER locale's files, which is exactly the
  // one-more-file-per-language trap this registry exists to avoid.
  nativeName: string
}

export const LANGUAGES: LanguageDef[] = [
  { code: 'en', nativeName: 'English' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'zh-CN', nativeName: '简体中文' },
  { code: 'es', nativeName: 'Español' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'ht', nativeName: 'Kreyòl ayisyen' },
]

// The authored language: new keys are written here first, and the locale
// parity test treats it as ground truth that every other registered
// language must match key-for-key.
export const SOURCE_LANGUAGE = 'en'

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code)
