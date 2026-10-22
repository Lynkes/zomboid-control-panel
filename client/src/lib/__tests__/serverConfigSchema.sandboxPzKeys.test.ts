import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import i18n from '@/i18n'
import { LANGUAGES } from '@/i18n/languages'
import { SANDBOX_SCHEMA, getSandboxSettingLabel, getSandboxSettingOptionLabel } from '../serverConfigSchema'
import {
  LANG_MAP,
  flattenLabels,
  loadOverrides,
  mergeLocaleLabels,
  parseJavapOptionTranslations,
  sharedLabelOptionNames,
  translationKeysFor,
} from '../../../scripts/extract-pz-sandbox-ground-truth.mjs'

// Pins which of Project Zomboid's own translation keys each sandbox setting
// is labelled from, and that the shipped locale files follow it.
//
// The old extractor guessed keys from the setting name, then from matching
// option-label sequences, and got several wrong in de/es/zh-CN: StatsDecrease
// and EndRegen showed food spoilage (FoodSpoil), LockedHouses showed house
// alarms (HouseAlarmFrequency), FishAbundance/NatureAbundance showed farming
// abundance (FarmingAmount), zombieLore.Strength showed the Strength XP
// multiplier (Sandbox_Strength), animals.Farming showed the Farming XP
// multiplier (Sandbox_Farming), and AnimalAgeModifier took its own vestigial
// 3-entry option list, leaving options 4-6 English. The extractor now reads
// the keys out of the game's bytecode; this test holds that line without a
// PZ install, via the committed fixture it writes.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(__dirname, '../../locales')
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../__fixtures__/pzSandboxGroundTruth.json'), 'utf8')) as {
  settings: Record<string, {
    key: string
    category: string
    pzLabelKey: string
    pzOptionsKey: string
    labels: Record<string, string | null>
    options: Array<{ value: number } & Record<string, string | number | null>>
  }>
}
const { curated, overrides } = loadOverrides() as {
  curated: Record<string, string>
  overrides: Record<string, Record<string, { value: string; pz: string; reason: string }>>
}

function localeLabels(lang: string): Record<string, string> {
  return flattenLabels(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, 'sandboxPz.json'), 'utf8')))
}

function setting(id: string) {
  const [category, key] = id.split('.')
  const found = SANDBOX_SCHEMA.find((s) => s.category === category && s.key === key)
  if (!found) throw new Error(`no SANDBOX_SCHEMA entry ${id}`)
  return found
}

// Read off B42.20.4's zombie.SandboxOptions constructors: the label is
// Sandbox_<setTranslation ?? shortName>, the options
// Sandbox_<setValueTranslation ?? setTranslation ?? shortName>_option<n>.
const BYTECODE_KEYS: Record<string, { label: string; options: string }> = {
  'survival.StatsDecrease': { label: 'StatDecrease', options: 'StatDecrease' },
  'survival.EndRegen': { label: 'EnduranceRegen', options: 'EnduranceRegen' },
  'survival.FoodRotSpeed': { label: 'FoodSpoil', options: 'FoodSpoil' },
  'survival.LockedHouses': { label: 'LockedHouseFrequency', options: 'LockedHouseFrequency' },
  'survival.Alarm': { label: 'HouseAlarmFrequency', options: 'HouseAlarmFrequency' },
  'survival.FishAbundance': { label: 'FishAmount', options: 'FishAmount' },
  'survival.NatureAbundance': { label: 'NatureAmount', options: 'NatureAmount' },
  'animals.PlantAbundance': { label: 'PlantAbundance', options: 'FarmingAmount' },
  'zombieLore.Strength': { label: 'ZStrength', options: 'ZStrength' },
  'animals.AnimalAgeModifier': { label: 'AnimalAgeModifier', options: 'AnimalSpeed' },
  'animals.AnimalStatsModifier': { label: 'AnimalStatsModifier', options: 'AnimalSpeed' },
  'animals.Farming': { label: 'FarmingSpeed', options: 'FarmingSpeed' },
  'zombieLore.PlayerSpawnZombieRemoval': { label: 'ZSpawnRemoval', options: 'ZSpawnRemoval' },
  'environment.AlarmDecay': { label: 'AlarmDecay', options: 'Shutoff' },
  'world.VehicleStoryChance': { label: 'VehicleStoryChance', options: 'SurvivorHouseChance' },
}

// Settings the game (or the old extractor) labelled alike that the panel
// must keep apart, in every language, as actually rendered.
const MUST_DIFFER: Array<[string, string]> = [
  ['survival.StatsDecrease', 'survival.FoodRotSpeed'],
  ['survival.EndRegen', 'survival.FoodRotSpeed'],
  ['survival.StatsDecrease', 'survival.EndRegen'],
  ['survival.LockedHouses', 'survival.Alarm'],
  ['survival.FishAbundance', 'animals.PlantAbundance'],
  ['survival.NatureAbundance', 'animals.PlantAbundance'],
  ['survival.FishAbundance', 'survival.NatureAbundance'],
  ['zombieLore.Strength', 'xpMultipliers.Strength'],
  ['animals.Farming', 'xpMultipliers.Farming'],
  ['animals.Farming', 'animals.FarmingSpeedNew'],
  ['environment.WaterShutModifier', 'environment.WaterShut'],
  ['environment.ElecShutModifier', 'environment.ElecShut'],
  ['environment.AlarmDecayModifier', 'environment.AlarmDecay'],
]

const PZ_SOURCED = Object.entries(LANG_MAP as Record<string, string | null>)
  .filter(([lang, dir]) => lang !== 'en' && dir && !(lang in curated))
  .map(([lang]) => lang)

describe('sandboxPz translation keys (bytecode-resolved)', () => {
  it.each(Object.entries(BYTECODE_KEYS))('%s reads the translation keys the game assigns it', (id, keys) => {
    const f = fixture.settings[id]
    expect(f, `${id} missing from the ground-truth fixture`).toBeDefined()
    expect({ label: f.pzLabelKey, options: f.pzOptionsKey }).toEqual(keys)
  })

  it('English animals.Farming is farming speed, 1 = Very Fast (Sandbox_FarmingSpeed), not the Agriculture XP multiplier', () => {
    const farming = setting('animals.Farming')
    expect(farming.options?.map((o) => o.label)).toEqual(['Very Fast', 'Fast', 'Normal', 'Slow', 'Very Slow'])
    expect(farming.label).not.toMatch(/multiplier/i)
    expect(fixture.settings['animals.Farming'].labels.en).toBe('Farming Speed')
  })

  it('covers every PZ-sourced locale', () => {
    expect(PZ_SOURCED.sort()).toEqual(['de', 'es', 'fr', 'pt-BR', 'zh-CN'])
  })

  it.each(PZ_SOURCED)('%s/sandboxPz.json ships the game\'s own text for exactly those keys, plus the recorded overrides', (lang) => {
    const shipped = localeLabels(lang)
    const langOverrides = overrides[lang] ?? {}
    const mismatches: string[] = []
    let compared = 0
    for (const [id, f] of Object.entries(fixture.settings)) {
      const s = setting(id)
      const expectLabel = (k: string, pz: string | null | undefined, english: string) => {
        compared++
        const want = langOverrides[k]?.value ?? pz ?? english
        if (shipped[k] !== want) mismatches.push(`${k}: ships "${shipped[k]}", expected "${want}"`)
      }
      expectLabel(`${id}.label`, f.labels[lang], s.label)
      for (const o of f.options) {
        const english = s.options?.find((so) => so.value === o.value)?.label ?? String(o.value)
        expectLabel(`${id}.options.${o.value}.label`, o[lang] as string | null, english)
      }
    }
    expect(compared).toBeGreaterThan(400)
    expect(mismatches, 'a hand edit that is not in scripts/sandboxPz.overrides.json would be lost on the next extractor run').toEqual([])
  })

  it('the reported de/es/zh-CN labels are the game\'s own text for the right key', () => {
    const de = localeLabels('de'), es = localeLabels('es'), zh = localeLabels('zh-CN')
    expect([de['survival.StatsDecrease.label'], es['survival.StatsDecrease.label'], zh['survival.StatsDecrease.label']]).toEqual(['Statusrückgang', 'Reducción de estados', '状态减少速度'])
    expect([de['survival.EndRegen.label'], es['survival.EndRegen.label'], zh['survival.EndRegen.label']]).toEqual(['Ausdauer-Regeneration', 'Regeneración de resistencia', '耐力恢复'])
    expect([de['survival.LockedHouses.label'], es['survival.LockedHouses.label'], zh['survival.LockedHouses.label']]).toEqual(['Häufigkeit von verschlossenen Häusern', 'Frecuencia de casas cerradas', '上锁房屋频率'])
    expect([de['survival.FishAbundance.label'], es['survival.FishAbundance.label'], zh['survival.FishAbundance.label']]).toEqual(['Fischreichtum', 'Abundancia de pesca', '鱼类产量'])
    expect([de['zombieLore.Strength.label'], es['zombieLore.Strength.label'], zh['zombieLore.Strength.label']]).toEqual(['Stärke', 'Fuerza', '力量'])
    expect([1, 2, 3, 4, 5, 6].map((n) => zh[`animals.AnimalAgeModifier.options.${n}.label`])).toEqual(['超快', '非常快', '快', '正常', '慢', '非常慢'])
    expect([1, 2, 3, 4, 5, 6].map((n) => de[`animals.AnimalAgeModifier.options.${n}.label`])).toEqual(['Ultra schnell', 'Sehr schnell', 'Schnell', 'Normal', 'Langsam', 'Sehr langsam'])
  })
})

describe('rendered sandbox labels keep look-alike settings apart in every language', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it.each(LANGUAGES.map((l) => l.code))('%s', async (lang) => {
    await i18n.changeLanguage(lang)
    const collisions = MUST_DIFFER
      .map(([a, b]) => [a, b, getSandboxSettingLabel(setting(a)), getSandboxSettingLabel(setting(b))])
      .filter(([, , la, lb]) => la === lb)
      .map(([a, b, la]) => `${a} and ${b} both render "${la}"`)
    expect(collisions).toEqual([])

    // AnimalAgeModifier reads the same AnimalSpeed scale as its siblings --
    // never its own shifted, half-English 3-entry list again.
    const age = setting('animals.AnimalAgeModifier'), stats = setting('animals.AnimalStatsModifier')
    const ageLabels = age.options!.map((o) => getSandboxSettingOptionLabel(age, o.value))
    expect(new Set(ageLabels).size, `AnimalAgeModifier options repeat a label: ${ageLabels.join(', ')}`).toBe(6)
    if (lang !== 'en') {
      const english = age.options!.map((o) => o.label)
      const statsLabels = stats.options!.map((o) => getSandboxSettingOptionLabel(stats, o.value))
      const untranslated = ageLabels.filter((l, i) => l === english[i] && statsLabels[i] !== english[i])
      expect(untranslated, 'AnimalAgeModifier options left in English where its sibling scale is translated').toEqual([])
    }
  })
})

describe('scripts/sandboxPz.overrides.json', () => {
  const en = localeLabels('en')

  it('every locale with a sandboxPz.json, and every registered language, is in the extractor\'s LANG_MAP', () => {
    const dirs = fs.readdirSync(LOCALES_DIR).filter((d) => fs.existsSync(path.join(LOCALES_DIR, d, 'sandboxPz.json')))
    expect(dirs.filter((d) => !(d in LANG_MAP))).toEqual([])
    expect(LANGUAGES.map((l) => l.code).filter((c) => !(c in LANG_MAP))).toEqual([])
  })

  it('curated locales are real locales and carry no per-key overrides', () => {
    for (const lang of Object.keys(curated)) {
      expect(lang in LANG_MAP, `${lang} is curated but not in LANG_MAP`).toBe(true)
      expect(overrides[lang], `${lang} is curated -- edit its file instead`).toBeUndefined()
    }
  })

  it('every override targets a live key, says why, records the game text it replaces, and is what the locale ships', () => {
    const problems: string[] = []
    for (const [lang, entries] of Object.entries(overrides)) {
      if (!PZ_SOURCED.includes(lang)) problems.push(`${lang}: overrides only apply to PZ-sourced locales`)
      const shipped = localeLabels(lang)
      for (const [k, o] of Object.entries(entries)) {
        if (!(k in en)) problems.push(`${lang} ${k}: not a sandboxPz key any more`)
        if (!o.reason?.trim() || typeof o.pz !== 'string' || o.pz === o.value) problems.push(`${lang} ${k}: needs a reason and the (different) game text it replaces`)
        if (shipped[k] !== o.value) problems.push(`${lang} ${k}: ships "${shipped[k]}", override says "${o.value}"`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('extract-pz-sandbox-ground-truth.mjs', () => {
  // Real `javap -c -p` lines from B42.20.4, trimmed to five options.
  const JAVAP = `
  public zombie.SandboxOptions();
    Code:
       0: aload_0
       1: invokespecial #1                  // Method java/lang/Object."<init>":()V
     110: aload_0
     111: aload_0
     112: ldc           #77                 // String DayLength
     114: bipush        27
     116: iconst_4
     117: invokevirtual #29                 // Method newEnumOption:(Ljava/lang/String;II)Lzombie/SandboxOptions$EnumSandboxOption;
     120: putfield      #79                 // Field dayLength:Lzombie/SandboxOptions$EnumSandboxOption;
     229: aload_0
     230: aload_0
     231: ldc           #120                // String WaterShut
     233: bipush        9
     235: iconst_2
     236: invokevirtual #29                 // Method newEnumOption:(Ljava/lang/String;II)Lzombie/SandboxOptions$EnumSandboxOption;
     239: ldc           #122                // String Shutoff
     241: invokevirtual #104                // Method zombie/SandboxOptions$EnumSandboxOption.setValueTranslation:(Ljava/lang/String;)Lzombie/SandboxOptions$EnumSandboxOption;
     244: putfield      #124                // Field waterShut:Lzombie/SandboxOptions$EnumSandboxOption;
     278: aload_0
     279: aload_0
     280: ldc           #137                // String WaterShutModifier
     282: iconst_m1
     283: ldc           #141                // int 2147483647
     285: bipush        14
     287: invokevirtual #142                // Method newIntegerOption:(Ljava/lang/String;III)Lzombie/SandboxOptions$IntegerSandboxOption;
     290: ldc           #120                // String WaterShut
     292: invokevirtual #146                // Method zombie/SandboxOptions$IntegerSandboxOption.setTranslation:(Ljava/lang/String;)Lzombie/SandboxOptions$IntegerSandboxOption;
     295: putfield      #151                // Field waterShutModifier:Lzombie/SandboxOptions$IntegerSandboxOption;
    1468: aload_0
    1469: aload_0
    1470: ldc_w         #566                // String InjurySeverity
    1473: ldc_w         #568                // class zombie/characters/InjurySeverity
    1476: getstatic     #570                // Field zombie/characters/InjurySeverity.NORMAL:Lzombie/characters/InjurySeverity;
    1479: invokevirtual #574                // Method newEnumOption:(Ljava/lang/String;Ljava/lang/Class;Ljava/lang/Enum;)Lzombie/SandboxOptions$StrongEnumSandboxOption;
    1482: putfield      #577                // Field injurySeverity:Lzombie/SandboxOptions$StrongEnumSandboxOption;
    2104: aload_0
    2105: aload_0
    2106: ldc_w         #812                // String AnimalAgeModifier
    2109: bipush        6
    2111: iconst_3
    2112: invokevirtual #29                 // Method newEnumOption:(Ljava/lang/String;II)Lzombie/SandboxOptions$EnumSandboxOption;
    2115: ldc_w         #797                // String AnimalSpeed
    2118: invokevirtual #104                // Method zombie/SandboxOptions$EnumSandboxOption.setValueTranslation:(Ljava/lang/String;)Lzombie/SandboxOptions$EnumSandboxOption;
    2121: putfield      #814                // Field animalAgeModifier:Lzombie/SandboxOptions$EnumSandboxOption;

  public static zombie.SandboxOptions getInstance();
    Code:
       0: getstatic     #1                  // Field instance:Lzombie/SandboxOptions;
       3: areturn

  public zombie.SandboxOptions$ZombieLore(zombie.SandboxOptions);
    Code:
       0: aload_0
       1: aload_1
       2: putfield      #7                  // Field this$0:Lzombie/SandboxOptions;
      58: aload_0
      59: getfield      #7                  // Field this$0:Lzombie/SandboxOptions;
      62: ldc           #56                 // String ZombieLore.Strength
      64: iconst_4
      65: iconst_2
      66: invokevirtual #21                 // Method zombie/SandboxOptions.newEnumOption:(Ljava/lang/String;II)Lzombie/SandboxOptions$EnumSandboxOption;
      69: ldc           #58                 // String ZStrength
      71: invokevirtual #29                 // Method zombie/SandboxOptions$EnumSandboxOption.setTranslation:(Ljava/lang/String;)Lzombie/SandboxOptions$EnumSandboxOption;
      74: putfield      #60                 // Field strength:Lzombie/SandboxOptions$EnumSandboxOption;
`

  it('reads each option\'s name, choice count and translation calls out of the constructors', () => {
    const table = parseJavapOptionTranslations(JAVAP)
    expect([...table.keys()]).toEqual(['DayLength', 'WaterShut', 'WaterShutModifier', 'InjurySeverity', 'AnimalAgeModifier', 'ZombieLore.Strength'])
    expect(table.get('DayLength')).toMatchObject({ kind: 'Enum', numChoices: 27, translation: null, valueTranslation: null })
    expect(table.get('WaterShut')).toMatchObject({ numChoices: 9, translation: null, valueTranslation: 'Shutoff' })
    expect(table.get('WaterShutModifier')).toMatchObject({ kind: 'Integer', numChoices: null, translation: 'WaterShut' })
    expect(table.get('InjurySeverity')).toMatchObject({ kind: 'StrongEnum', numChoices: null })
    expect(table.get('AnimalAgeModifier')).toMatchObject({ numChoices: 6, valueTranslation: 'AnimalSpeed' })
    expect(table.get('ZombieLore.Strength')).toMatchObject({ numChoices: 4, translation: 'ZStrength' })
  })

  it('resolves keys the way EnumSandboxOption does, and flags labels shared with a sibling option', () => {
    const table = parseJavapOptionTranslations(JAVAP)
    expect(translationKeysFor(table.get('DayLength'))).toEqual({ labelKey: 'DayLength', optionsKey: 'DayLength' })
    expect(translationKeysFor(table.get('WaterShut'))).toEqual({ labelKey: 'WaterShut', optionsKey: 'Shutoff' })
    expect(translationKeysFor(table.get('AnimalAgeModifier'))).toEqual({ labelKey: 'AnimalAgeModifier', optionsKey: 'AnimalSpeed' })
    expect(translationKeysFor(table.get('ZombieLore.Strength'))).toEqual({ labelKey: 'ZStrength', optionsKey: 'ZStrength' })
    expect([...sharedLabelOptionNames(table)]).toEqual(['WaterShutModifier'])
  })

  describe('mergeLocaleLabels (what a re-run keeps)', () => {
    const generated = { 'a.X.label': 'game X', 'a.Y.label': 'game Y', 'a.Z.label': 'English Z' }

    it('PZ-sourced: game text wins over the committed file, except where an override says otherwise', () => {
      const { labels, notes } = mergeLocaleLabels({
        locale: 'fr',
        generated,
        existing: { 'a.X.label': 'hand edit X', 'a.Y.label': 'hand edit Y', 'a.Gone.label': 'stale' },
        curated: false,
        overrides: { 'a.Y.label': { value: 'fixed Y', pz: 'game Y', reason: 'game text is wrong' } },
      })
      expect(labels).toEqual({ 'a.X.label': 'game X', 'a.Y.label': 'fixed Y', 'a.Z.label': 'English Z' })
      expect(notes).toEqual([])
    })

    it('curated: every committed value survives, missing keys are filled, removed keys are dropped', () => {
      const { labels } = mergeLocaleLabels({
        locale: 'zh-TW',
        generated,
        existing: { 'a.X.label': 'curated X', 'a.Gone.label': 'stale' },
        curated: true,
      })
      expect(labels).toEqual({ 'a.X.label': 'curated X', 'a.Y.label': 'game Y', 'a.Z.label': 'English Z' })
    })

    it('says when the game text moved under an override, or caught up with it', () => {
      const { notes } = mergeLocaleLabels({
        locale: 'fr',
        generated,
        existing: {},
        curated: false,
        overrides: {
          'a.X.label': { value: 'fixed X', pz: 'old game X', reason: 'r' },
          'a.Y.label': { value: 'game Y', pz: 'older Y', reason: 'r' },
        },
      })
      expect(notes).toHaveLength(2)
      expect(notes[0]).toMatch(/game text changed/)
      expect(notes[1]).toMatch(/redundant/)
    })

    it('refuses an override for a key the schema no longer has, or for a curated locale', () => {
      expect(() => mergeLocaleLabels({ locale: 'fr', generated, existing: {}, curated: false, overrides: { 'a.Gone.label': { value: 'v', pz: 'p', reason: 'r' } } })).toThrow(/no such key/)
      expect(() => mergeLocaleLabels({ locale: 'zh-TW', generated, existing: {}, curated: true, overrides: { 'a.X.label': { value: 'v', pz: 'p', reason: 'r' } } })).toThrow(/curated/)
    })
  })
})
