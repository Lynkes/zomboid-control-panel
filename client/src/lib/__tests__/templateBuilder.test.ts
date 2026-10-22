import { describe, expect, it } from 'vitest'
import { buildTemplateCapture, TEMPLATE_INI_EXCLUSIONS } from '../templateBuilder'

const emptySandbox = {
  settings: {},
  ZombieLore: {},
  ZombieConfig: {},
  MultiplierConfig: {},
  Map: {},
  Basement: {},
}

describe('buildTemplateCapture', () => {
  it('strips excluded identity/secret ini keys', () => {
    const { serverIni } = buildTemplateCapture(
      { PauseEmpty: 'true', RCONPassword: 'secret', ServerName: 'MyServer' },
      emptySandbox,
    )
    expect(serverIni).toEqual({ PauseEmpty: 'true' })
    for (const key of TEMPLATE_INI_EXCLUSIONS) {
      expect(serverIni).not.toHaveProperty(key)
    }
  })

  // SECURITY (2026-10-20): keys other capabilities govern and anything
  // secret-like (a masked DiscordToken) never go into a template; the server
  // refuses a template holding one (templateSchema.js's isIniKeyExcluded()).
  it('strips governed keys, secret-like keys by pattern, and keys in any case', () => {
    const { serverIni } = buildTemplateCapture(
      {
        PVP: 'true',
        Mods: 'A;B',
        WorkshopItems: '1;2',
        Map: 'Muldraugh, KY',
        DoLuaChecksum: 'true',
        UPnP: 'false',
        upnp: 'true',
        DiscordToken: '••••••••',
        SomeApiKey: 'k',
      },
      emptySandbox,
    )
    expect(serverIni).toEqual({ PVP: 'true' })
  })

  it('shapes sandboxVars into the six known sections', () => {
    const { sandboxVars } = buildTemplateCapture({}, {
      ...emptySandbox,
      settings: { Zombies: 5 },
      ZombieLore: { Speed: 2 },
    })
    expect(sandboxVars).toEqual({
      settings: { Zombies: 5 },
      ZombieLore: { Speed: 2 },
      ZombieConfig: {},
      MultiplierConfig: {},
      Map: {},
      Basement: {},
    })
  })

  it('counts ini and sandbox keys', () => {
    const capture = buildTemplateCapture(
      { PauseEmpty: 'true', PVP: 'false' },
      { ...emptySandbox, settings: { Zombies: 5 }, Map: { Foo: 1, Bar: 2 } },
    )
    expect(capture.iniKeyCount).toBe(2)
    expect(capture.sandboxKeyCount).toBe(3)
  })
})
