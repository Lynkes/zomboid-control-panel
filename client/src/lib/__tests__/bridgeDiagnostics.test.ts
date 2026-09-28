import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { bridgeDiagnosticParams } from '../bridgeDiagnostics'

// Review of the merge: bridgeSilentSinceStart (and statusFileStale before
// it) filled {{age}} with the server's English compact units inside
// translated sentences -- pt-BR "O servidor de jogo foi iniciado há 12m",
// where a bare m reads as metres, beside the Dashboard's "ativo há 12 min".
describe('bridgeDiagnosticParams', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it("re-words the age in the UI language's units when the server sends it as a number", async () => {
    await i18n.changeLanguage('pt-BR')
    const params = bridgeDiagnosticParams({ age: '12m', ageSeconds: 12 * 60 + 30 })
    expect(params.age).toBe('12 min')
    expect(
      i18n.t('bridge.diagnostics.bridgeSilentSinceStart', { ns: 'settings', ...params, defaultValue: 'x' }),
    ).toMatch(/há 12 min\b/)
  })

  it("keeps the server's own age from a server that sends no number", () => {
    expect(bridgeDiagnosticParams({ age: '12m' })).toEqual({ age: '12m' })
    expect(bridgeDiagnosticParams(undefined)).toEqual({})
    expect(bridgeDiagnosticParams({ filename: 'status.json', error: 'EACCES' })).toEqual({
      filename: 'status.json', error: 'EACCES',
    })
  })
})

// Review of the Workshop-delivery merge: the silent-since-start remedy said
// "check that PanelBridge is in the server's active mod list". For the
// default panel-installed delivery PanelBridge.lua sits loose in the game
// folder and is never in Mods=, and on a Local server a Mods= entry is the
// local-workshop-loaded misconfiguration -- so the advice led the wrong way
// half the time. Every place that gives it now points at the block that
// knows the server's method, by that block's own heading in each language:
// the Settings diagnostic, the World Map check, and Checks & Fixes'
// bridge.heartbeat "never" variant (which used to say "Verify PanelBridge is
// in the server's mod list and Workshop subscription").
const settingsByLocale = import.meta.glob('../../locales/*/settings.json', { eager: true, import: 'default' }) as Record<
  string,
  { bridge: { diagnostics: { bridgeSilentSinceStart: string } } }
>
const debugByLocale = import.meta.glob('../../locales/*/debug.json', { eager: true, import: 'default' }) as Record<
  string,
  {
    diagnostics: {
      checks: {
        worldmap: { bridge: { mod: { warn: { hint: string } } } }
        bridge: { heartbeat: { fail: { never: { hint: string } } } }
      }
    }
  }
>
const deliveryByLocale = import.meta.glob('../../locales/*/bridgeDelivery.json', { eager: true, import: 'default' }) as Record<
  string,
  { sectionTitle: string }
>

describe('the "PanelBridge stays silent" remedies', () => {
  const locales = Object.keys(deliveryByLocale).map((file) => file.split('/').at(-2) as string)

  it('covers every locale', () => {
    expect(locales.length).toBeGreaterThanOrEqual(10)
  })

  it.each(locales)('%s points at How PanelBridge is installed, whatever the delivery method', (locale) => {
    const sectionTitle = deliveryByLocale[`../../locales/${locale}/bridgeDelivery.json`].sectionTitle
    const silent = settingsByLocale[`../../locales/${locale}/settings.json`].bridge.diagnostics.bridgeSilentSinceStart
    const checks = debugByLocale[`../../locales/${locale}/debug.json`].diagnostics.checks
    const mapHint = checks.worldmap.bridge.mod.warn.hint
    const neverHint = checks.bridge.heartbeat.fail.never.hint
    expect(silent).toContain(sectionTitle)
    expect(mapHint).toContain(sectionTitle)
    expect(neverHint).toContain(sectionTitle)
    // Nothing that only fits Workshop delivery.
    expect(neverHint).not.toMatch(/Workshop|Mods=/)
  })
})
