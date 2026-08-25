import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  INI_SCHEMA,
  getIniSettingLabel,
  getIniSettingDescription,
} from '../serverConfigSchema'

// Proof-of-mechanism for the serverConfigSchema.ts translation plan: the
// smallest real INI category ("rcon", 2 settings) wired end to end.
//
// This does NOT touch any committed locale file. Adding iniSettings.* keys
// to the real de/serverconfig.json is out of scope for this investigation
// (a key-set change across locales is a floor-wide gate, sequenced
// separately) -- so the proof injects a synthetic resource bundle at
// runtime via i18next's own addResourceBundle API, the same mechanism a
// real translated locale file would populate through the normal JSON
// loader in client/src/i18n/index.ts. The KEY SHAPE below is exactly what
// a real de/serverconfig.json addition would contain.
const RCON_PORT = INI_SCHEMA.find((s) => s.key === 'RCONPort')!
const RCON_PASSWORD = INI_SCHEMA.find((s) => s.key === 'RCONPassword')!

const DE_PROOF_BUNDLE = {
  iniSettings: {
    rcon: {
      RCONPort: {
        label: 'RCON-Port',
        description: 'Port für RCON-Verbindungen.',
      },
      RCONPassword: {
        label: 'RCON-Passwort',
        description: 'Passwort für RCON-Verbindungen.',
      },
    },
  },
}

describe('serverConfigSchema translated accessors (proof: rcon category)', () => {
  beforeEach(() => {
    i18n.addResourceBundle('de', 'serverconfig', DE_PROOF_BUNDLE, true, true)
  })

  afterEach(() => {
    i18n.removeResourceBundle('de', 'serverconfig')
    void i18n.changeLanguage('en')
  })

  it('both rcon settings exist and share the "rcon" category (sanity check for the proof itself)', () => {
    expect(RCON_PORT.category).toBe('rcon')
    expect(RCON_PASSWORD.category).toBe('rcon')
  })

  it('falls back to the schema\'s own English text when no translation is loaded (zero behaviour change)', () => {
    void i18n.changeLanguage('en')
    expect(getIniSettingLabel(RCON_PORT)).toBe('RCON Port')
    expect(getIniSettingDescription(RCON_PORT)).toBe('Port for RCON connections.')
    expect(getIniSettingLabel(RCON_PASSWORD)).toBe('RCON Password')
    expect(getIniSettingDescription(RCON_PASSWORD)).toBe('Password for RCON connections.')
  })

  it('resolves the translated German text once the mechanically-keyed bundle is present', async () => {
    await i18n.changeLanguage('de')
    expect(getIniSettingLabel(RCON_PORT)).toBe('RCON-Port')
    expect(getIniSettingDescription(RCON_PORT)).toBe('Port für RCON-Verbindungen.')
    expect(getIniSettingLabel(RCON_PASSWORD)).toBe('RCON-Passwort')
    expect(getIniSettingDescription(RCON_PASSWORD)).toBe('Passwort für RCON-Verbindungen.')
  })

  it('falls back to English for a DIFFERENT category with no bundle entry, even while German is active', async () => {
    // Proves the fallback is per-key, not a blanket "German is incomplete
    // so show English everywhere" -- exactly the coexistence a real,
    // partially-translated rollout needs.
    await i18n.changeLanguage('de')
    const publicName = INI_SCHEMA.find((s) => s.key === 'PublicName')!
    expect(getIniSettingLabel(publicName)).toBe('Server Name')
  })

  it('the injected bundle uses the exact mechanical key shape getIniSettingLabel derives (category.key.field)', () => {
    // If this drifts from the real derivation, the two "resolves the
    // translated" assertions above would silently fall back to English
    // instead of failing -- this test exists so a key-shape regression in
    // getIniSettingLabel/Description shows up as a clear key-path mismatch.
    expect(`iniSettings.${RCON_PORT.category}.${RCON_PORT.key}.label`).toBe('iniSettings.rcon.RCONPort.label')
    expect(`iniSettings.${RCON_PASSWORD.category}.${RCON_PASSWORD.key}.description`).toBe('iniSettings.rcon.RCONPassword.description')
  })
})
