#!/usr/bin/env node
// Writes client/src/locales/<lang>/pzCharacter.json: the game's own names for
// skills (perks), skill categories, professions and traits, in every locale
// the panel ships, for the Players page's Character tab. The tab falls back
// to the name PanelBridge sends, then to the id, for anything not listed
// here (mod skills, mod professions).
//
// Sources, all read-only from a local Project Zomboid install (Build 42):
//   - Skills: media/lua/shared/Translate/<LANG>/IG_UI.json, key
//     IGUI_perks_<translation name>. The translation name is the name
//     PerkFactory.init() registers each perk under (javap -c on
//     zombie.characters.skills.PerkFactory, 42.21), which is the perk id
//     except for the six listed in TRANSLATION_NAME below. English carries
//     both IGUI_perks_Woodwork and IGUI_perks_Carpentry, but the game itself
//     resolves Carpentry.
//   - Professions and traits: the UIName of each definition in
//     media/scripts/generated/characters/character_{professions,traits}.txt,
//     looked up in Translate/<LANG>/UI.json.
//
// Curated locales (client/scripts/pzCharacter.overrides.json):
//   - ht has no game translation, so every value is curated.
//   - ar's game files hold Spanish, so any ar value with no Arabic-script
//     character is replaced by the curated value.
//   - `overrides.<lang>.<key>` replaces one game value in any locale, with
//     the game's text and a reason recorded next to it.
//
// Keys: perks.<PerkId>, perkCategories.<Id>, professions.<id without
// "base:">, traits.<id without "base:">. No ':' inside a key.
//
// Run by hand after a game update:
//   node client/scripts/extract-pz-character-names.mjs [<PZ install>]
//   node client/scripts/extract-pz-character-names.mjs --check   (no writes;
//     exits 1 if a curated value is missing or a file would change)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = path.resolve(__dirname, '..')
const LOCALES_DIR = path.join(CLIENT_ROOT, 'src/locales')
const OVERRIDES_PATH = path.join(__dirname, 'pzCharacter.overrides.json')

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const PZ_ROOT = args.find((a) => !a.startsWith('--')) || 'D:/SteamLibrary/steamapps/common/ProjectZomboid'
const TRANSLATE_DIR = path.join(PZ_ROOT, 'media/lua/shared/Translate')
const CHARACTERS_DIR = path.join(PZ_ROOT, 'media/scripts/generated/characters')

// Our locale code -> the game's Translate folder (null: no game translation).
const LANG_MAP = {
  en: 'EN',
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  'zh-CN': 'CN',
  'zh-TW': 'CH',
  'pt-BR': 'PTBR',
  uk: 'UA',
  ar: 'AR',
  ht: null,
}

// Every perk PerkFactory.init() registers in 42.21, in registration order.
// category: registered without a parent (the skill groups).
const PERKS = [
  { id: 'Combat', category: true },
  { id: 'Axe' },
  { id: 'Blunt' },
  { id: 'SmallBlunt' },
  { id: 'LongBlade' },
  { id: 'SmallBlade' },
  { id: 'Spear' },
  { id: 'Maintenance' },
  { id: 'Firearm', category: true },
  { id: 'Aiming' },
  { id: 'Reloading' },
  { id: 'Crafting', category: true },
  { id: 'Woodwork' },
  { id: 'Carving' },
  { id: 'Cooking' },
  { id: 'Electricity' },
  { id: 'Doctor' },
  { id: 'Glassmaking' },
  { id: 'FlintKnapping' },
  { id: 'Masonry' },
  { id: 'Blacksmith' },
  { id: 'Mechanics' },
  { id: 'Pottery' },
  { id: 'Tailoring' },
  { id: 'MetalWelding' },
  { id: 'Survivalist', category: true },
  { id: 'Fishing' },
  { id: 'PlantScavenging' },
  { id: 'Tracking' },
  { id: 'Trapping' },
  { id: 'PhysicalCategory', category: true },
  { id: 'Fitness' },
  { id: 'Strength' },
  { id: 'Agility', category: true },
  { id: 'Lightfoot' },
  { id: 'Nimble' },
  { id: 'Sprinting' },
  { id: 'Sneak' },
  { id: 'FarmingCategory', category: true },
  { id: 'Farming' },
  { id: 'Husbandry' },
  { id: 'Butchering' },
]

// Perk id -> the translation name PerkFactory registers it under (spec P7).
const TRANSLATION_NAME = {
  Woodwork: 'Carpentry',
  PlantScavenging: 'Foraging',
  Lightfoot: 'Lightfooted',
  Sneak: 'Sneaking',
  Combat: 'CombatMelee',
  Firearm: 'CombatFirearms',
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function loadTranslate(pzDir, name) {
  if (!pzDir) return {}
  const file = path.join(TRANSLATE_DIR, pzDir, name)
  return fs.existsSync(file) ? readJson(file) : {}
}

// character_<kind>_definition base:<id> { ... UIName = UI_x, ... }
function parseDefinitions(file, kind) {
  const src = fs.readFileSync(file, 'utf8')
  const re = new RegExp(`character_${kind}_definition\\s+(\\S+)\\s*\\{([^}]*)\\}`, 'g')
  const out = []
  let m
  while ((m = re.exec(src))) {
    const [, fullId, body] = m
    if (!fullId.startsWith('base:')) continue
    const uiName = body.match(/UIName\s*=\s*([^,\s]+)/)?.[1]
    if (uiName) out.push({ id: fullId.slice('base:'.length), uiName })
  }
  if (out.length === 0) throw new Error(`No ${kind} definitions found in ${file}`)
  return out
}

// key -> the game's translation key (IG_UI for perks, UI for the rest)
function sourceKeys() {
  const keys = []
  for (const perk of PERKS) {
    const translationName = TRANSLATION_NAME[perk.id] ?? perk.id
    keys.push({
      key: `${perk.category ? 'perkCategories' : 'perks'}.${perk.id}`,
      file: 'IG_UI.json',
      pzKey: `IGUI_perks_${translationName}`,
    })
  }
  for (const def of parseDefinitions(path.join(CHARACTERS_DIR, 'character_professions.txt'), 'profession')) {
    keys.push({ key: `professions.${def.id}`, file: 'UI.json', pzKey: def.uiName })
  }
  for (const def of parseDefinitions(path.join(CHARACTERS_DIR, 'character_traits.txt'), 'trait')) {
    keys.push({ key: `traits.${def.id}`, file: 'UI.json', pzKey: def.uiName })
  }
  for (const { key } of keys) {
    if (key.split('.').length !== 2 || key.includes(':')) throw new Error(`Unusable key ${key}`)
  }
  return keys
}

function nest(flat) {
  const out = { perks: {}, perkCategories: {}, professions: {}, traits: {} }
  for (const [key, value] of Object.entries(flat)) {
    const [group, id] = key.split('.')
    out[group][id] = value
  }
  for (const group of Object.keys(out)) {
    out[group] = Object.fromEntries(Object.entries(out[group]).sort(([a], [b]) => a.localeCompare(b, 'en')))
  }
  return out
}

function main() {
  const overridesFile = readJson(OVERRIDES_PATH)
  const curated = overridesFile.curated ?? {}
  const overrides = overridesFile.overrides ?? {}
  const keys = sourceKeys()
  const english = { 'IG_UI.json': loadTranslate('EN', 'IG_UI.json'), 'UI.json': loadTranslate('EN', 'UI.json') }
  const problems = []
  let changed = 0

  for (const [lang, pzDir] of Object.entries(LANG_MAP)) {
    const game = { 'IG_UI.json': loadTranslate(pzDir, 'IG_UI.json'), 'UI.json': loadTranslate(pzDir, 'UI.json') }
    const curatedValues = curated[lang] ?? null
    const flat = {}
    for (const { key, file, pzKey } of keys) {
      const englishValue = english[file][pzKey]
      if (typeof englishValue !== 'string' || !englishValue.trim()) {
        problems.push(`en: no ${file} ${pzKey} for ${key}`)
        continue
      }
      let value
      if (lang === 'ht') {
        value = curatedValues?.[key]
        if (!value) problems.push(`ht: curated value missing for ${key} (en: ${englishValue})`)
      } else {
        value = game[file][pzKey]
        if (lang === 'ar' && !(typeof value === 'string' && ARABIC_SCRIPT.test(value))) {
          value = curatedValues?.[key]
          if (!value) problems.push(`ar: curated value missing for ${key} (en: ${englishValue})`)
        }
      }
      const override = overrides[lang]?.[key]
      if (override) {
        if (!override.value || !override.reason) problems.push(`${lang}: override for ${key} needs value and reason`)
        value = override.value
      }
      // A game locale that simply lacks a string shows English, which is
      // what the game itself does.
      flat[key] = typeof value === 'string' && value.trim() ? value.trim() : englishValue.trim()
    }
    const out = JSON.stringify(nest(flat), null, 2) + '\n'
    const file = path.join(LOCALES_DIR, lang, 'pzCharacter.json')
    let before = null
    try {
      before = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (before !== out) {
      changed += 1
      if (CHECK) problems.push(`${lang}/pzCharacter.json is out of date`)
      else fs.writeFileSync(file, out)
    }
  }

  for (const [lang, values] of Object.entries(curated)) {
    const known = new Set(keys.map((k) => k.key))
    for (const key of Object.keys(values)) {
      if (!key.startsWith('_') && !known.has(key)) problems.push(`${lang}: curated value for unknown key ${key}`)
    }
  }

  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`${keys.length} names per locale; ${CHECK ? `${changed} file(s) would change` : `${changed} file(s) written`}.`)
}

main()
