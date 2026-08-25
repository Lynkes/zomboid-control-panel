import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { LANGUAGE_CODES, SOURCE_LANGUAGE } from './languages'

export { LANGUAGES, SOURCE_LANGUAGE, LANGUAGE_CODES } from './languages'
export type { LanguageDef } from './languages'
export type SupportedLanguage = string

export const LANGUAGE_STORAGE_KEY = 'zcp-language'

// Discovers every client/src/locales/<code>/<namespace>.json file at build
// time — no per-language, per-namespace import list to maintain. Adding a
// language folder (or a namespace file within one) is picked up here with
// no code change. See client/src/locales/README.md.
// i18next's own Resource type is this loose (ResourceKey = string | an
// object of unspecified shape), so `any` here matches its actual contract
// rather than fighting it with a narrower type that doesn't describe it.
const localeModules = import.meta.glob('../locales/*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, any>

const LOCALE_PATH_RE = /\.\.\/locales\/([^/]+)\/([^/]+)\.json$/

const resources: Record<string, Record<string, any>> = {}
for (const [filePath, mod] of Object.entries(localeModules)) {
  const match = filePath.match(LOCALE_PATH_RE)
  if (!match) continue
  const [, code, namespace] = match
  resources[code] ??= {}
  resources[code][namespace] = mod
}

const namespaces = [...new Set(Object.values(resources).flatMap((r) => Object.keys(r)))]

function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
  return !!value && LANGUAGE_CODES.includes(value)
}

// Phase 1 covers Login, Setup and the app shell/nav only — every other page
// still renders hardcoded English. See the i18n scoping report for the plan
// to roll the remaining strings out namespace by namespace.
function detectInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isSupportedLanguage(stored)) return stored
  } catch {
    // localStorage unavailable (privacy mode, disabled storage) — fall through
  }
  const browserLang = (navigator.language || SOURCE_LANGUAGE).slice(0, 2).toLowerCase()
  return isSupportedLanguage(browserLang) ? browserLang : SOURCE_LANGUAGE
}

i18n.use(initReactI18next).init({
  resources,
  lng: detectInitialLanguage(),
  fallbackLng: SOURCE_LANGUAGE,
  ns: namespaces,
  defaultNS: 'shell',
  interpolation: { escapeValue: false }, // React already escapes interpolated values
  returnEmptyString: false,
})

export function setLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang)
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang)
  } catch {
    // ignore — language just won't persist across reloads
  }
}

export function getCurrentLanguage(): SupportedLanguage {
  return isSupportedLanguage(i18n.language) ? i18n.language : SOURCE_LANGUAGE
}

export default i18n
