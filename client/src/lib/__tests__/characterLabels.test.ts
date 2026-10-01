import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { LANGUAGE_CODES } from '@/i18n/languages'
import { categoryLabel, makeCollator, perkLabel, professionLabel, sortByLabel, traitLabel } from '@/lib/characterLabels'
import enPz from '@/locales/en/pzCharacter.json'

const en = i18n.getFixedT('en', 'pzCharacter')
const fr = i18n.getFixedT('fr', 'pzCharacter')
const ar = i18n.getFixedT('ar', 'pzCharacter')

describe('characterLabels', () => {
  it('uses the game name in the panel language first', () => {
    expect(perkLabel(en, { id: 'Woodwork', name: 'Woodwork' })).toBe('Carpentry')
    expect(perkLabel(fr, { id: 'Woodwork', name: 'Carpentry' })).toBe('Menuiserie')
    expect(categoryLabel(en, { id: 'Combat', name: 'Combat' })).toBe('Combat - Melee')
    expect(traitLabel(en, { id: 'base:athletic', label: 'Athletic' })).toBe('Athletic')
    expect(traitLabel(fr, { id: 'base:athletic', label: 'Athletic' })).not.toBe('Athletic')
    expect(professionLabel(en, { id: 'base:repairman', label: 'x' })).toBe('DIY Expert')
  })

  it('Arabic names are Arabic script, never the Spanish the game ships for AR', () => {
    const label = perkLabel(ar, { id: 'Woodwork' })
    expect(label).toMatch(/[؀-ۿ]/)
    expect(label).not.toBe('Carpintería')
  })

  it('falls back to the bridge name, then to the id, for anything the game files do not name', () => {
    expect(perkLabel(en, { id: 'Beekeeping', name: 'Beekeeping (mod)' })).toBe('Beekeeping (mod)')
    expect(perkLabel(en, { id: 'Beekeeping' })).toBe('Beekeeping')
    expect(traitLabel(en, { id: 'somemod:lucky', label: 'Lucky' })).toBe('Lucky')
    expect(traitLabel(en, { id: 'somemod:lucky' })).toBe('somemod:lucky')
    expect(professionLabel(en, { id: 'somemod:pilot', label: 'Pilot' })).toBe('Pilot')
    expect(professionLabel(en, undefined)).toBeUndefined()
    expect(professionLabel(en, {})).toBeUndefined()
  })

  it('never lets an id pick a namespace or a nested key', () => {
    expect(perkLabel(en, { id: 'players:tabs.character', name: 'Odd' })).toBe('Odd')
    expect(perkLabel(en, { id: 'a.b', name: 'Dotted' })).toBe('Dotted')
  })

  it('sorts by the displayed label with the language collator', () => {
    const collator = makeCollator('en')
    const perks = [{ id: 'Woodwork' }, { id: 'Axe' }, { id: 'Cooking' }]
    expect(sortByLabel(perks, (p) => perkLabel(en, p), collator).map((p) => p.id)).toEqual(['Axe', 'Woodwork', 'Cooking'])
    expect(makeCollator('not a language!').compare('a', 'b')).toBeLessThan(0)
  })

  it('every locale names the same skills, categories, professions and traits', () => {
    const groups = Object.keys(enPz)
    expect(groups).toEqual(['perks', 'perkCategories', 'professions', 'traits'])
    for (const code of LANGUAGE_CODES) {
      const bundle = i18n.getResourceBundle(code, 'pzCharacter') as Record<string, Record<string, string>>
      for (const group of groups) {
        expect(Object.keys(bundle[group]).sort(), `${code} ${group}`).toEqual(
          Object.keys((enPz as Record<string, Record<string, string>>)[group]).sort(),
        )
      }
      for (const key of Object.keys(bundle.perks)) expect(key).not.toMatch(/[:.]/)
    }
  })
})
