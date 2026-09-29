import { describe, expect, it } from 'vitest'

// The PanelBridge delivery copy sends the operator to other screens by
// breadcrumb. They used to name tabs that don't exist ("Settings › Mods",
// "Server Config › INI (raw)"), and the translations copied them, so some
// locales contradicted their own UI (es "(en bruto)" beside a toggle that
// reads "Texto plano"). Each breadcrumb now uses that locale's own labels,
// taken here from the files that render them.
type Json = Record<string, unknown>
const all = import.meta.glob('../*/*.json', { eager: true, import: 'default' }) as Record<string, Json>
const localeOf = (file: string) => file.split('/').at(-2) as string
const locales = [...new Set(Object.keys(all).map(localeOf))].sort()
const ns = (locale: string, name: string) => all[`../${locale}/${name}.json`] as Json

function get(obj: Json, path: string): string {
  const value = path.split('.').reduce<unknown>((node, key) => (node as Json | undefined)?.[key], obj)
  if (typeof value !== 'string') throw new Error(`missing ${path}`)
  return value
}

describe('PanelBridge delivery breadcrumbs name the real screens', () => {
  it('covers every locale', () => {
    expect(locales.length).toBeGreaterThanOrEqual(10)
  })

  it.each(locales)('%s', (locale) => {
    const delivery = ns(locale, 'bridgeDelivery')
    const serverConfigNav = get(ns(locale, 'shell'), 'nav.items.serverConfiguration')
    const serverSettingsTab = get(ns(locale, 'serverconfig'), 'tabs.serverSettings')
    const rawToggle = get(ns(locale, 'serverconfig'), 'editorToolbar.raw')
    const modsTab = get(ns(locale, 'settings'), 'tabs.mods.label')

    for (const key of [
      'unavailable.iniDuplicateKeys',
      'state.local-workshop-loaded.manualHint',
      'checksumOffer.openServerConfig',
      'toast.notRestored',
      'toast.notRestoredFile',
    ]) {
      const text = get(delivery, key)
      expect(text, key).toContain(serverConfigNav)
      expect(text, key).toContain(serverSettingsTab)
      expect(text, key).not.toMatch(/›\s*INI\b/)
    }
    expect(get(delivery, 'unavailable.iniDuplicateKeys')).toContain(rawToggle)
    expect(get(delivery, 'banner.autoRestartOn')).toContain(modsTab)
    expect(get(delivery, 'banner.autoRestartOff')).toContain(modsTab)
  })
})
