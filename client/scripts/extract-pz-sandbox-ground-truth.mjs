#!/usr/bin/env node
// Extracts Project Zomboid's own sandbox ground truth (default values, and
// select-option values/labels in English + every locale PZ itself ships)
// from a local PZ install, and writes:
//   1. client/src/lib/__fixtures__/pzSandboxGroundTruth.json -- the single
//      committed fixture serverConfigSchema.pzGroundTruth.test.ts diffs
//      SANDBOX_SCHEMA against on every test run (the drift gate).
//   2. client/src/locales/<lang>/sandboxPz.json for every registered locale --
//      the setting/option LABELS the panel actually renders, sourced from
//      the exact same resolved data as the fixture above. One extractor,
//      one resolved mapping, two outputs -- not two independent parsers
//      that can silently drift apart from each other.
//
// Run manually: `node scripts/extract-pz-sandbox-ground-truth.mjs <path to PZ install>`
// (no PZ install path -> defaults to the well-known dev machine location
// below; this script is never run in CI, only by hand when re-syncing
// against a new PZ build -- see the fixture's own _provenance block for
// when it was last run and against which PZ build). Needs `javap` (any JDK)
// on PATH: the translation keys are read out of projectzomboid.jar itself.
//
// READ-ONLY on the PZ install. Never writes anything under it.
//
// WHICH TRANSLATION KEY BELONGS TO WHICH OPTION: the game decides, in
// bytecode, and this script reads that decision instead of guessing it.
// zombie.SandboxOptions$EnumSandboxOption (B42.20.4) resolves
//   label:   "Sandbox_" + (translation ?? shortName)
//   option:  "Sandbox_" + (valueTranslation ?? translation ?? shortName) + "_option" + n
// where shortName is the part after the dot ("ZombieLore.Strength" ->
// "Strength") and translation/valueTranslation are set by chained
// setTranslation()/setValueTranslation() calls in the option-group
// constructors. So StatsDecrease reads Sandbox_StatDecrease, EndRegen reads
// Sandbox_EnduranceRegen, ZombieLore.Strength reads Sandbox_ZStrength, and
// AnimalAgeModifier's options read Sandbox_AnimalSpeed_option*. An earlier
// version of this script guessed keys from the setting name and, failing
// that, from matching option-label sequences -- which picked the FIRST
// group with the same "Very Fast..Very Slow" scale (FoodSpoil for both
// StatsDecrease and EndRegen, HouseAlarmFrequency for LockedHouses,
// FarmingAmount for FishAbundance/NatureAbundance, Sandbox_Strength -- the
// XP multiplier -- for zombie strength) and shipped those wrong labels in
// de/es/zh-CN. Don't reintroduce a fallback guess: an option the jar table
// doesn't cover gets the schema's English, and the run says so.
//
// HAND FIXES SURVIVE A RE-RUN. scripts/sandboxPz.overrides.json holds
// (a) per-key overrides for PZ-sourced locales -- places where the game's
// own translation is wrong or unusable, each with the game text it replaces
// and why -- applied on top of the extraction every run, and (b) curated
// locales, whose committed file is the source of truth: a re-run keeps every
// existing value and only fills keys the file doesn't have yet (from the
// game's translation where PZ ships one, else English) and drops keys the
// schema no longer has. See that file's own _readme.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = path.resolve(__dirname, '..')

const PZ_ROOT = process.argv[2] || 'D:/SteamLibrary/steamapps/common/ProjectZomboid'
const APOC_PATH = path.join(PZ_ROOT, 'media/lua/shared/Sandbox/Apocalypse.lua')
const TRANSLATE_DIR = path.join(PZ_ROOT, 'media/lua/shared/Translate')
const JAR_PATH = path.join(PZ_ROOT, 'projectzomboid.jar')
const APP_MANIFEST_PATH = path.resolve(PZ_ROOT, '..', '..', 'appmanifest_108600.acf')

const SCHEMA_PATH = path.join(CLIENT_ROOT, 'src/lib/serverConfigSchema.ts')
const FIXTURE_PATH = path.join(CLIENT_ROOT, 'src/lib/__fixtures__/pzSandboxGroundTruth.json')
const LOCALES_DIR = path.join(CLIENT_ROOT, 'src/locales')
export const OVERRIDES_PATH = path.join(CLIENT_ROOT, 'scripts/sandboxPz.overrides.json')

// Our locale code -> PZ language dir (null: PZ ships no translation for it).
// Every locale with a sandboxPz.json must be listed here (main() refuses to
// run otherwise): this repo's localeParity test requires every registered
// locale to share the exact same key set, so a locale this script skipped
// would fall out of step the first time the schema gained or lost a key.
// Watch the dir names: PZ's AR is Argentinian Spanish, not Arabic, and its
// CH is Traditional Chinese.
export const LANG_MAP = { en: 'EN', de: 'DE', es: 'ES', fr: 'FR', 'zh-CN': 'CN', 'zh-TW': 'CH', 'pt-BR': 'PTBR', uk: 'UA', ht: null, ar: null }

// The six classes whose constructors define every sandbox option.
const PZ_OPTION_CLASSES = [
  'zombie.SandboxOptions',
  'zombie.SandboxOptions$ZombieLore',
  'zombie.SandboxOptions$MultiplierConfig',
  'zombie.SandboxOptions$ZombieConfig',
  'zombie.SandboxOptions$Map',
  'zombie.SandboxOptions$Basement',
]

function loadSandboxJson(pzDir) {
  if (!pzDir) return {}
  const p = path.join(TRANSLATE_DIR, pzDir, 'Sandbox.json')
  if (!fs.existsSync(p)) return {}
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// ---------- projectzomboid.jar (which translation key each option reads) ----------
// Walks `javap -c -p` output of the option-group constructors. Each option is
// one statement:
//   ldc "StatsDecrease"; iconst_5; iconst_3; invokevirtual newEnumOption(String,int,int)
//   ldc "StatDecrease";  invokevirtual EnumSandboxOption.setTranslation(String)
//   putfield statsDecrease
// Returns Map<option name, { name, kind, translation, valueTranslation, numChoices }>.
// numChoices is only known for int-backed enums (newEnumOption(name, n, default));
// StrongEnumSandboxOption's count lives in its Java enum class and stays null.
export function parseJavapOptionTranslations(javapText) {
  const out = new Map()
  const lines = javapText.split(/\r?\n/)
  const ctorRe = /^\s+(?:public |protected |private )?zombie\.SandboxOptions(?:\$\w+)?\([^)]*\);$/
  for (let i = 0; i < lines.length; i++) {
    if (!ctorRe.test(lines[i])) continue
    let cur = null, strs = [], ints = []
    for (i++; i < lines.length && lines[i].trim() !== ''; i++) {
      const l = lines[i]
      const str = l.match(/\/\/ String (.*)$/)
      if (str) { strs.push(str[1]); continue }
      const int = l.match(/\b(?:iconst_(m1|\d)|[bs]ipush\s+(-?\d+))\s*$/) || l.match(/\/\/ int (-?\d+)$/)
      if (int) { ints.push(int[1] === 'm1' ? -1 : Number(int[1] ?? int[2])); continue }
      const factory = l.match(/Method (?:zombie\/SandboxOptions\.)?new(\w+)Option:\(Ljava\/lang\/String;([^)]*)\)/)
      if (factory) {
        const strong = factory[2].includes('Ljava/lang/Class;')
        cur = {
          name: strs[0],
          kind: strong ? 'StrongEnum' : factory[1],
          translation: null,
          valueTranslation: null,
          numChoices: factory[1] === 'Enum' && !strong ? ints[ints.length - 2] ?? null : null,
        }
        continue
      }
      const setter = l.match(/\.(setTranslation|setValueTranslation):\(Ljava\/lang\/String;\)/)
      if (setter && cur) {
        cur[setter[1] === 'setTranslation' ? 'translation' : 'valueTranslation'] = strs[strs.length - 1]
        continue
      }
      if (/\bputfield\b/.test(l)) {
        if (cur?.name) out.set(cur.name, cur)
        cur = null; strs = []; ints = []
      }
    }
  }
  return out
}

function shortNameOf(name) {
  return name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
}

// The same resolution EnumSandboxOption.getTranslatedName()/getValueTranslation() perform.
export function translationKeysFor(opt) {
  const shortName = shortNameOf(opt.name)
  return {
    labelKey: opt.translation ?? shortName,
    optionsKey: opt.valueTranslation ?? opt.translation ?? shortName,
  }
}

// Options whose setTranslation() points at ANOTHER option's own name share
// that option's label in-game: WaterShutModifier/ElecShutModifier/
// AlarmDecayModifier call setTranslation("WaterShut"/"ElecShut"/"AlarmDecay"),
// so B42 shows "Water Shutoff" for both the enum and its day-count modifier.
// The panel lists both side by side, so for these the locale's dedicated
// Sandbox_<shortName> string wins where PZ still ships one (ES/FR/CN/CH carry
// "Modificador del corte de agua" etc.; the game no longer reads them), and
// the schema's English otherwise -- never the sibling's label.
export function sharedLabelOptionNames(jarOptions) {
  const shortNames = new Set([...jarOptions.values()].map((o) => shortNameOf(o.name)))
  const out = new Set()
  for (const o of jarOptions.values()) {
    const shortName = shortNameOf(o.name)
    if (o.translation && o.translation !== shortName && shortNames.has(o.translation)) out.add(o.name)
  }
  return out
}

function readJarOptionTranslations() {
  if (!fs.existsSync(JAR_PATH)) {
    throw new Error(`projectzomboid.jar not found at ${JAR_PATH} -- pass the PZ install root as an argument.`)
  }
  let text
  try {
    text = execFileSync('javap', ['-c', '-p', '-cp', JAR_PATH, ...PZ_OPTION_CLASSES], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(`javap failed (a JDK must be on PATH): ${err.message}`)
  }
  const table = parseJavapOptionTranslations(text)
  if (table.size < 200) {
    throw new Error(`only ${table.size} sandbox options parsed out of the jar -- the javap output shape changed; fix the parser before trusting anything it resolves.`)
  }
  return table
}

// ---------- Apocalypse.lua (PZ's own default table) ----------
function parseApocalypse(src) {
  const out = { settings: {}, ZombieLore: {}, ZombieConfig: {}, MultiplierConfig: {}, Map: {}, Basement: {} }
  const sections = new Set(['ZombieLore', 'ZombieConfig', 'MultiplierConfig', 'Map', 'Basement'])
  let section = 'settings'
  for (const line of src.split('\n')) {
    const secOpen = line.match(/^\s*(\w+)\s*=\s*\{\s*$/)
    if (secOpen && sections.has(secOpen[1])) { section = secOpen[1]; continue }
    if (/^\s*\},?\s*$/.test(line) && section !== 'settings') { section = 'settings'; continue }
    const kv = line.match(/^\s*(\w+)\s*=\s*(true|false|-?[\d.]+|"[^"]*")\s*,?\s*$/)
    if (kv && kv[1] !== 'Version') {
      let v = kv[2]
      if (v === 'true') v = true
      else if (v === 'false') v = false
      else if (/^".*"$/.test(v)) v = v.slice(1, -1)
      else v = Number(v)
      out[section][kv[1]] = v
    }
  }
  return out
}

// ---------- serverConfigSchema.ts SANDBOX_SCHEMA ----------
function extractObjects(src) {
  const items = []
  let objStart = -1, depth = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '{') { if (depth === 0) objStart = i; depth++ }
    else if (c === '}') {
      depth--
      if (depth === 0 && objStart !== -1) {
        const body = src.slice(objStart, i + 1)
        if (/\bkey\s*:\s*'/.test(body)) items.push(body)
        objStart = -1
      }
    }
  }
  return items
}

function parseOptions(body) {
  const optIdx = body.indexOf('options')
  if (optIdx === -1) return []
  const bracketStart = body.indexOf('[', optIdx)
  if (bracketStart === -1) return []
  let d = 0, j = bracketStart
  for (; j < body.length; j++) {
    if (body[j] === '[') d++
    else if (body[j] === ']') { d--; if (d === 0) break }
  }
  const optionsText = body.slice(bracketStart + 1, j)
  const out = []
  const optRe = /\{\s*value\s*:\s*([^,]+?)\s*,\s*label\s*:\s*'((?:[^'\\]|\\.)*)'\s*\}/g
  let m
  while ((m = optRe.exec(optionsText))) out.push({ value: m[1].trim(), label: m[2].replace(/\\'/g, "'") })
  return out
}

function parseSchemaEntry(body) {
  const keyM = body.match(/\bkey\s*:\s*'([^']*)'/)
  const catM = body.match(/\bcategory\s*:\s*'([^']*)'/)
  const sectionM = body.match(/\bsection\s*:\s*'([^']*)'/)
  const labelM = body.match(/\blabel\s*:\s*'((?:[^'\\]|\\.)*)'/)
  const typeM = body.match(/\btype\s*:\s*'([^']*)'/)
  const defaultM = body.match(/\bdefault\s*:\s*([^,\n]+)/)
  return {
    key: keyM ? keyM[1] : null,
    category: catM ? catM[1] : null,
    section: sectionM ? sectionM[1] : 'settings',
    label: labelM ? labelM[1].replace(/\\'/g, "'") : null,
    type: typeM ? typeM[1] : null,
    default: defaultM ? defaultM[1].trim() : null,
    options: parseOptions(body),
  }
}

// SANDBOX_SCHEMA's `section` is the Lua table the key lives in; the jar names
// nested options "<Table>.<Key>" ("ZombieLore.Strength").
function pzOptionName(e) {
  return e.section === 'settings' ? e.key : `${e.section}.${e.key}`
}

// The label PZ ships for a resolved schema entry in one language's
// Sandbox.json, or null. A label the game shares with a sibling option takes
// the dedicated Sandbox_<key> string instead (see sharedLabelOptionNames);
// EN's placeholder for those is the bare key itself, which doesn't count.
function pzLabelText(e, json) {
  if (!e.labelKey) return null
  const v = e.sharedLabel ? json[`Sandbox_${e.key}`] : json[`Sandbox_${e.labelKey}`]
  return typeof v === 'string' && v.trim() !== '' && !(e.sharedLabel && v === e.key) ? v : null
}

// ---------- locale files: flat "<category>.<key>.label" / ".options.<n>.label" maps ----------
export function flattenLabels(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flattenLabels(v, p, out)
    else out[p] = v
  }
  return out
}

// Rebuilds the nested file shape from a flat map, in the flat map's own key
// order (which is schema order -- see generatedLabels in main()).
export function unflattenLabels(flat) {
  const out = {}
  for (const [p, v] of Object.entries(flat)) {
    const parts = p.split('.')
    let node = out
    for (const part of parts.slice(0, -1)) node = node[part] ??= {}
    node[parts[parts.length - 1]] = v
  }
  return out
}

// Produces one locale's final flat label map from:
//   generated -- this run's extraction (PZ translation, else schema English),
//                keyed and ordered exactly like the schema
//   existing  -- the committed file's flat map (or {} for a new locale)
//   curated   -- true: the committed file is the source of truth
//   overrides -- { flatKey: { value, pz, reason } } for a PZ-sourced locale
// Returns { labels, notes }; notes are human-readable warnings for the run log.
// Throws on an override that can't be applied, so a stale override never
// silently stops doing its job.
export function mergeLocaleLabels({ locale, generated, existing, curated, overrides = {} }) {
  const labels = {}
  const notes = []
  const overrideKeys = Object.keys(overrides)
  if (curated && overrideKeys.length > 0) {
    throw new Error(`${locale} is a curated locale -- edit its sandboxPz.json directly instead of listing overrides for it (${overrideKeys.join(', ')})`)
  }
  for (const k of overrideKeys) {
    if (!(k in generated)) throw new Error(`${locale} override for ${k}: no such key in SANDBOX_SCHEMA any more -- remove it from ${path.basename(OVERRIDES_PATH)}`)
  }
  for (const [k, gen] of Object.entries(generated)) {
    if (curated) {
      labels[k] = typeof existing[k] === 'string' && existing[k] !== '' ? existing[k] : gen
      continue
    }
    const o = overrides[k]
    if (!o) { labels[k] = gen; continue }
    if (gen === o.value) notes.push(`${locale} ${k}: the extraction now yields the override's own value "${o.value}" -- the override is redundant, drop it`)
    else if (gen !== o.pz) notes.push(`${locale} ${k}: the game text changed from "${o.pz}" (when the override was recorded) to "${gen}" -- re-check whether the override "${o.value}" is still needed`)
    labels[k] = o.value
  }
  return { labels, notes }
}

export function loadOverrides(file = OVERRIDES_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { curated: raw.curatedLocales ?? {}, overrides: raw.overrides ?? {} }
}

function main() {
  if (!fs.existsSync(APOC_PATH)) {
    console.error(`Apocalypse.lua not found at ${APOC_PATH} -- pass the PZ install root as an argument.`)
    process.exit(1)
  }

  const localeDirs = fs.readdirSync(LOCALES_DIR).filter((d) => fs.existsSync(path.join(LOCALES_DIR, d, 'sandboxPz.json')))
  const unmapped = localeDirs.filter((d) => !(d in LANG_MAP))
  if (unmapped.length > 0) {
    console.error(`sandboxPz.json exists for locale(s) missing from LANG_MAP: ${unmapped.join(', ')} -- add them (PZ dir or null) before re-running.`)
    process.exit(1)
  }

  const { curated, overrides } = loadOverrides()
  const jarOptions = readJarOptionTranslations()
  const apoc = parseApocalypse(fs.readFileSync(APOC_PATH, 'utf8'))
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8')
  const sandboxSrc = schemaSrc.slice(schemaSrc.indexOf('export const SANDBOX_SCHEMA'))
  const entries = extractObjects(sandboxSrc).map(parseSchemaEntry).filter((e) => e.key)

  const enJson = loadSandboxJson('EN')
  const perLangJson = Object.fromEntries(Object.entries(LANG_MAP).map(([code, dir]) => [code, code === 'en' ? enJson : loadSandboxJson(dir)]))

  const notInJar = []
  const sharedLabels = sharedLabelOptionNames(jarOptions)
  const resolved = entries.map((e) => {
    const jar = jarOptions.get(pzOptionName(e))
    if (!jar) { notInJar.push(`${e.category}.${e.key}`); return { ...e, labelKey: null, optionsKey: null, numChoices: null, sharedLabel: false } }
    const { labelKey, optionsKey } = translationKeysFor(jar)
    const sharedLabel = sharedLabels.has(pzOptionName(e))
    let numChoices = jar.numChoices
    if (numChoices == null && e.type === 'select') {
      // StrongEnum: the count is the Java enum's; the EN option strings the game shows are the best local proxy.
      const re = new RegExp(`^Sandbox_${optionsKey}_option(\\d+)$`)
      numChoices = Math.max(0, ...Object.keys(enJson).map((k) => Number(k.match(re)?.[1] ?? 0))) || null
    }
    return { ...e, labelKey, optionsKey, numChoices, sharedLabel }
  })

  // ---------- Fixture: SELECT-type entries whose PZ option strings exist ----------
  // Scope matches this gate's actual job (option value/label drift, the
  // PlantResilience-class bug) -- defaults for ALL 269 entries were already
  // verified against Apocalypse.lua once (see the enum-audit report); this
  // fixture re-asserts default + option data together, per select setting,
  // going forward. pzLabelKey/pzOptionsKey record the bytecode-resolved
  // translation keys and labels/options the game's text for them, so tests
  // can pin both the mapping and the shipped locale files without a PZ install.
  // Known-untrustworthy PZ references: the key resolves cleanly but PZ's OWN
  // EN Sandbox.json entry is the one that's wrong, not our schema. Excluding
  // these here means the drift gate compares against PZ where PZ is
  // trustworthy, instead of failing forever (or worse, "fixing" correct code
  // to match a stale reference). Each entry must carry the evidence, not
  // just an ID -- this list is deliberately hard to add to by accident.
  // (animals.AnimalAgeModifier used to be here: its own
  // Sandbox_AnimalAgeModifier_option* has only 3 entries. The bytecode shows
  // the game never reads those -- it calls setValueTranslation("AnimalSpeed"),
  // the same 6-step scale as its siblings -- so it resolves cleanly now.)
  const KNOWN_STALE_PZ_REFERENCES = {}

  const fixtureLangs = Object.keys(LANG_MAP).filter((code) => code !== 'en' && LANG_MAP[code])
  const settings = {}
  const skipped = []
  for (const e of resolved) {
    if (e.type !== 'select' || e.options.length === 0) continue
    const id = `${e.category}.${e.key}`
    const hasEn = e.optionsKey && e.numChoices && enJson[`Sandbox_${e.optionsKey}_option1`] !== undefined
    if (!hasEn) { skipped.push(id); continue }
    if (id in KNOWN_STALE_PZ_REFERENCES) continue
    const options = []
    for (let n = 1; n <= e.numChoices; n++) {
      const row = { value: n, en: enJson[`Sandbox_${e.optionsKey}_option${n}`] ?? null }
      for (const code of fixtureLangs) {
        const v = perLangJson[code][`Sandbox_${e.optionsKey}_option${n}`]
        row[code] = typeof v === 'string' && v.trim() !== '' ? v : null
      }
      options.push(row)
    }
    const labels = Object.fromEntries(['en', ...fixtureLangs].map((code) => [code, pzLabelText(e, perLangJson[code])]))
    const apocSection = apoc[e.section] || apoc.settings
    settings[id] = {
      key: e.key,
      category: e.category,
      section: e.section,
      pzLabelKey: e.labelKey,
      pzOptionsKey: e.optionsKey,
      default: apocSection[e.key] ?? null,
      labels,
      options,
    }
  }

  let buildId = null
  try {
    const manifest = fs.readFileSync(APP_MANIFEST_PATH, 'utf8')
    buildId = manifest.match(/"buildid"\s*"(\d+)"/)?.[1] ?? null
  } catch { /* manifest not found -- leave buildId null, don't fail extraction over it */ }

  const fixture = {
    _provenance: {
      pzAppId: '108600',
      pzBuildId: buildId,
      extractedAt: new Date().toISOString().slice(0, 10),
      sources: {
        translationKeys: 'projectzomboid.jar: zombie.SandboxOptions (+ ZombieLore/MultiplierConfig/ZombieConfig/Map/Basement) constructors, via javap',
        defaults: 'media/lua/shared/Sandbox/Apocalypse.lua',
        ...Object.fromEntries(
          Object.entries(LANG_MAP).filter(([, dir]) => dir).map(([code, dir]) => [`optionLabels.${code}`, `media/lua/shared/Translate/${dir}/Sandbox.json`]),
        ),
      },
      note:
        'Paths are relative to the PZ Steam install root. ht and ar have no PZ translation (PZ\'s AR is Argentinian Spanish) and carry no per-language column here. ' +
        'Option rows are 1..numChoices as the jar declares it (newEnumOption(name, numChoices, default)), labelled from the translation key the jar assigns. ' +
        'Scope: only SANDBOX_SCHEMA select-type entries whose PZ option strings exist in EN. ' +
        `${skipped.length} select-type entries have none and are intentionally excluded: ${skipped.join(', ') || '(none)'}. ` +
        `${Object.keys(KNOWN_STALE_PZ_REFERENCES).length} more resolved but PZ's own reference is known-stale and intentionally excluded ` +
        `(see knownStalePzReferences below for each one's evidence): ${Object.keys(KNOWN_STALE_PZ_REFERENCES).join(', ') || '(none)'}.`,
      knownStalePzReferences: KNOWN_STALE_PZ_REFERENCES,
      settingCount: Object.keys(settings).length,
    },
    settings,
  }

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true })
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n', 'utf8')
  console.log(`Wrote fixture: ${FIXTURE_PATH} (${fixture._provenance.settingCount} settings)`)
  if (notInJar.length > 0) console.warn(`\nNot defined in the jar (English only, check the schema): ${notInJar.join(', ')}`)

  // ---------- Locale files: full key skeleton for every registered locale ----------
  // Every SANDBOX_SCHEMA entry (not just the select-type/fixture-scoped ones)
  // gets a label; select-type entries also get option labels. en's file is
  // the full skeleton (its own values, mechanically equal to the schema's
  // inline fallback) and every other locale matches its key set exactly
  // (localeParity requirement), using PZ's own translation where available
  // and the same schema-derived English text as an explicit value everywhere
  // PZ has no translation for that key -- then overrides / curation on top.
  const report = {}
  const allNotes = []
  for (const [localeCode, pzDir] of Object.entries(LANG_MAP)) {
    const json = perLangJson[localeCode]
    const generated = {}
    let labelHit = 0, optionHit = 0, labelTotal = 0, optionTotal = 0

    for (const e of resolved) {
      labelTotal++
      let labelText = e.label
      if (localeCode === 'en') labelHit++
      else if (pzDir) {
        const v = pzLabelText(e, json)
        if (v) { labelText = v; labelHit++ }
      }
      generated[`${e.category}.${e.key}.label`] = labelText

      if (e.type === 'select' && e.options.length > 0) {
        for (const opt of e.options) {
          optionTotal++
          let optText = opt.label
          if (localeCode === 'en') optionHit++
          else if (pzDir && e.optionsKey) {
            const v = json[`Sandbox_${e.optionsKey}_option${Number(opt.value)}`]
            if (typeof v === 'string' && v.trim() !== '') { optText = v; optionHit++ }
          }
          generated[`${e.category}.${e.key}.options.${opt.value}.label`] = optText
        }
      }
    }

    const outPath = path.join(LOCALES_DIR, localeCode, 'sandboxPz.json')
    const existing = fs.existsSync(outPath) ? flattenLabels(JSON.parse(fs.readFileSync(outPath, 'utf8'))) : {}
    const isCurated = localeCode in curated
    const { labels, notes } = mergeLocaleLabels({
      locale: localeCode,
      generated,
      existing,
      curated: isCurated,
      overrides: overrides[localeCode],
    })
    allNotes.push(...notes)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(unflattenLabels(labels), null, 2) + '\n', 'utf8')

    const differsFromGame = Object.keys(labels).filter((k) => labels[k] !== generated[k]).length
    const dropped = Object.keys(existing).filter((k) => !(k in generated))
    report[localeCode] = {
      pz: `labels ${labelHit}/${labelTotal}, options ${optionHit}/${optionTotal}`,
      mode: localeCode === 'en' ? 'schema English' : isCurated ? `curated (${differsFromGame} values kept that differ from the extraction)` : `PZ-sourced (${Object.keys(overrides[localeCode] ?? {}).length} overrides)`,
      dropped,
    }
  }

  console.log('\nReal PZ translation coverage (files are always 100% key-complete; this is how much is an actual PZ translation vs. an English backfill):')
  for (const [lang, r] of Object.entries(report)) {
    console.log(`  ${lang}: ${r.pz} -- ${r.mode}`)
    if (r.dropped.length > 0) console.log(`      dropped ${r.dropped.length} key(s) the schema no longer has: ${r.dropped.join(', ')}`)
  }
  if (allNotes.length > 0) {
    console.warn('\nOverrides to review:')
    for (const n of allNotes) console.warn(`  ${n}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
