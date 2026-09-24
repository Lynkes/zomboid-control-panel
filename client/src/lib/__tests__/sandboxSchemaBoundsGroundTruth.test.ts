import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SANDBOX_SCHEMA } from '../serverConfigSchema'

// The numeric-bounds drift gate: catches SANDBOX_SCHEMA's min/max/enum-choice
// numbers silently disagreeing with what B42 actually accepts. Complements
// serverConfigSchema.pzGroundTruth.test.ts (which gates select-type option
// LABELS and DEFAULTS against a translation-file-derived fixture) -- this one
// gates the numeric VALIDATOR BOUNDS (min/max, and an enum's valid value
// range) against a bytecode-level fixture, because a translation file has no
// concept of an integer/double field's min or max at all, and (as this round
// found for AlarmDecay/VehicleStoryChance/ZoneStoryChance) a translation-file
// derived option COUNT can itself be wrong when PZ's client reuses a shared
// label set across fields with genuinely different real ranges.
//
// Regenerate the fixture with:
//   node scripts/jar-audit/extract-sandbox-options.mjs <path-to-projectzomboid.jar>
//
// 2026-09-18, round 15 of the continuous-bug-hunt: this schema had drifted
// on ~20 fields (see server/__fixtures__/pzSandboxOptions.json's own
// _provenance for how the ground truth here was produced, and this repo's
// jim-mtvld337 hive memory for the full round-14/15 writeup). Every mismatch
// this gate found was either fixed in SANDBOX_SCHEMA or, where fixing it
// would need real UI work (a plain 'number' field would need to become a
// 'select' to properly model a Java-enum-backed option), added to the
// ALLOWLIST below with a dated reason -- so this test asserts ZERO drift
// outside that allowlist, not "no NEW drift since some point in the past."

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, '../../../../server/__fixtures__/pzSandboxOptions.json')

type RealOption =
  | { type: 'integer' | 'double'; min: number; max: number; default: number; fieldName: string }
  | { type: 'enum'; min: number; max: number; default: number; fieldName: string }
  | { type: 'boolean'; default: boolean | number; fieldName: string }
  | { type: 'string'; default: string; fieldName: string }

type Fixture = { _provenance: Record<string, unknown>; options: Record<string, RealOption> }

function loadFixture(): Fixture | null {
  if (!fs.existsSync(FIXTURE_PATH)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.options || typeof parsed.options !== 'object') return null
    return parsed as Fixture
  } catch {
    return null
  }
}

function qualifiedName(setting: { key: string; section?: string }): string {
  return setting.section && setting.section !== 'settings' ? `${setting.section}.${setting.key}` : setting.key
}

// Floating-point constants read out of the class file can carry a
// float->double widening artifact (e.g. ZombieLore.FenceDamageMultiplier's
// real min is the double value of a 0.01f literal, 0.009999999776482582,
// not a clean 0.01) -- a schema author writing a clean, readable 0.01 is
// not drift. Anything past a millionth is a real mismatch.
const EPSILON = 1e-6

// ---- Allowlist: every KNOWN, judged-intentional disagreement between
// SANDBOX_SCHEMA and the real game, each with a dated reason. A qualified
// name (section.key, or bare key when section is 'settings') present here
// is fully skipped by every comparison below -- type, min, and max.
const ALLOWLIST: Record<string, string> = {
  // StrongEnumSandboxOption fields (Java-enum-backed: a Class<EnumType> +
  // enum constant, not a min/max int pair) -- scripts/jar-audit/
  // extract-sandbox-options.mjs deliberately does not extract these (see
  // its own header comment), so they have no fixture entry to compare
  // against at all. Modeling them properly would need the same kind of
  // UI work as the 4 number-vs-enum entries below.
  InjurySeverity: '2026-09-18: StrongEnumSandboxOption (zombie.characters.InjurySeverity) -- no numeric ground truth extracted, see extract-sandbox-options.mjs header.',
  DamageToPlayerFromHitByACar: '2026-09-18: StrongEnumSandboxOption -- no numeric ground truth extracted, see extract-sandbox-options.mjs header.',

  // Real PZ enums SANDBOX_SCHEMA models as a plain 'number' input instead of
  // a 'select' dropdown -- functionally still bounded by min/max either way
  // (parseNumericSettingValue enforces both), so not the "silently accepts
  // an invalid value" bug class this gate exists to catch; fixing the TYPE
  // SHAPE (number -> select, with an options array and translated labels)
  // is real UI work, left for a dedicated round rather than bundled here.
  StartYear: "2026-09-18: real enum (newEnumOption('StartYear', 100, 1)), schema models it as a free-typed 'number' 1-100 -- functionally bounded the same either way.",
  StartDay: "2026-09-18: real enum (newEnumOption('StartDay', 31, 23)), schema models it as a free-typed 'number' 1-31 -- functionally bounded the same either way.",
  ConstructionBonusPoints: "2026-09-18: real enum (newEnumOption('ConstructionBonusPoints', 5, 3)), schema models it as a free-typed 'number' 1-5 -- functionally bounded the same either way.",
  FirearmUseDamageChance: "2026-09-18: real enum (newEnumOption('FirearmUseDamageChance', 3, 2)), schema models it as a free-typed 'number' 1-3 -- functionally bounded the same either way.",

  // Deliberately conservative UI cap, not drift in the dangerous direction:
  // the real max is 2147483647 (Integer.MAX_VALUE, PZ's own "no limit"
  // sentinel for this field), but exposing that raw value as the slider/
  // input max is worse UX than a human-scaled cap; 8760 hours = 1 year is
  // already far beyond any real server's retention setting. TIGHTER than
  // the game (blocks an extreme value), never LOOSER, so it cannot produce
  // the "saved a value the game then rejects" bug this gate is watching
  // for.
  HoursForWorldItemRemoval: '2026-09-18: schema max 8760 (1 year) vs real max 2147483647 (PZ\'s own "unlimited" sentinel) -- deliberately conservative UI cap, not a validator-bypass risk.',
}

// The 36 MultiplierConfig.* skill/global XP entries all share the exact
// same intentional divergence: real min is 0, schema min is 0.001. A 0
// multiplier is a real, PZ-accepted value, but letting an operator actually
// set one here means every one of that skill's XP gains multiplies by
// zero forever with no in-UI way to tell why levelling stopped -- not
// dangerous (the game accepts a stricter subset of what it itself allows,
// same "TIGHTER, not LOOSER" direction as HoursForWorldItemRemoval above),
// and worth keeping as a guardrail rather than "fixing" down to 0.
function isAllowlistedMultiplierMin(qname: string): boolean {
  return qname.startsWith('MultiplierConfig.')
}

const fixture = loadFixture()
const realOptions = fixture ? fixture.options : {}
const realCount = Object.keys(realOptions).length

describe('SANDBOX_SCHEMA numeric bounds vs the real B42 game (bytecode ground truth)', () => {
  it('the fixture exists, is valid JSON, and has a substantial option set', () => {
    expect(
      fixture,
      `ground-truth fixture missing or unparseable at ${FIXTURE_PATH} -- run: ` +
        'node scripts/jar-audit/extract-sandbox-options.mjs <path-to-projectzomboid.jar>',
    ).not.toBeNull()
    // 267 at the time this gate was written; a real drop (e.g. a bad
    // extractor edit silently returning far fewer) should fail loudly
    // rather than this test quietly comparing almost nothing.
    expect(realCount, 'fixture has an implausibly small option set').toBeGreaterThan(200)
  })

  it('every SANDBOX_SCHEMA numeric/select entry (outside the allowlist) has a real ground-truth match', () => {
    const missing: string[] = []
    for (const setting of SANDBOX_SCHEMA) {
      if (setting.type !== 'number' && setting.type !== 'select') continue
      const qname = qualifiedName(setting)
      if (ALLOWLIST[qname]) continue
      if (!realOptions[qname]) missing.push(qname)
    }
    expect(missing, 'SANDBOX_SCHEMA entries with no corresponding real option in the fixture (not in the allowlist)').toEqual([])
  })

  it('type shape matches (number vs select) outside the allowlist', () => {
    const mismatches: Array<{ qname: string; real: string; schema: string }> = []
    let compared = 0
    for (const setting of SANDBOX_SCHEMA) {
      if (setting.type !== 'number' && setting.type !== 'select') continue
      const qname = qualifiedName(setting)
      if (ALLOWLIST[qname]) continue
      const real = realOptions[qname]
      if (!real) continue // reported by the previous test
      compared++
      const realIsEnum = real.type === 'enum'
      if (realIsEnum && setting.type !== 'select') mismatches.push({ qname, real: real.type, schema: setting.type })
      if (!realIsEnum && setting.type !== 'number') mismatches.push({ qname, real: real.type, schema: setting.type })
    }
    expect(compared).toBeGreaterThan(0)
    expect(mismatches, 'schema type shape disagrees with the real option type').toEqual([])
  })

  it('min/max bounds are at least as strict as the real game everywhere, and match exactly outside the allowlist', () => {
    const mismatches: Array<{ qname: string; field: 'min' | 'max'; schema: number; real: number }> = []
    let compared = 0
    for (const setting of SANDBOX_SCHEMA) {
      if (setting.type !== 'number') continue
      const qname = qualifiedName(setting)
      if (ALLOWLIST[qname]) continue
      const real = realOptions[qname]
      if (!real || (real.type !== 'integer' && real.type !== 'double')) continue
      compared++
      if (typeof setting.min === 'number' && Math.abs(setting.min - real.min) > EPSILON && !isAllowlistedMultiplierMin(qname)) {
        mismatches.push({ qname, field: 'min', schema: setting.min, real: real.min })
      }
      if (typeof setting.max === 'number' && Math.abs(setting.max - real.max) > EPSILON) {
        mismatches.push({ qname, field: 'max', schema: setting.max, real: real.max })
      }
    }
    expect(compared).toBeGreaterThan(0)
    expect(
      mismatches,
      'schema min/max disagrees with the real game -- if LOOSER, an operator can save a value the real sandbox loader rejects; if TIGHTER and unintentional, it blocks a real accepted value',
    ).toEqual([])
  })

  it('every enum entry\'s option values are exactly the real accepted range outside the allowlist', () => {
    const mismatches: Array<{ qname: string; issue: string; value: number }> = []
    let compared = 0
    for (const setting of SANDBOX_SCHEMA) {
      if (setting.type !== 'select' || !setting.options) continue
      const qname = qualifiedName(setting)
      if (ALLOWLIST[qname]) continue
      const real = realOptions[qname]
      if (!real || real.type !== 'enum') continue
      compared++
      const realValues = new Set<number>()
      for (let v = real.min; v <= real.max; v++) realValues.add(v)
      for (const opt of setting.options) {
        if (!realValues.has(opt.value)) mismatches.push({ qname, issue: 'schema offers a value the game does not accept', value: opt.value })
      }
      for (const v of realValues) {
        if (!setting.options.some((o) => o.value === v)) mismatches.push({ qname, issue: 'schema is missing a value the game accepts', value: v })
      }
    }
    expect(compared).toBeGreaterThan(0)
    expect(mismatches, 'schema enum options disagree with the real game\'s accepted value range').toEqual([])
  })

  it('the allowlist itself only names entries that genuinely still disagree (no stale allowlisting)', () => {
    // An allowlist entry for a field that has since been fixed to actually
    // match is dead weight that would hide a REAL future regression on that
    // same field (the comparisons above skip anything allowlisted
    // unconditionally). Each entry here must still diverge from the
    // fixture in the dimension its own reason describes.
    const staleEntries: string[] = []
    for (const qname of Object.keys(ALLOWLIST)) {
      const setting = SANDBOX_SCHEMA.find((s) => qualifiedName(s) === qname)
      const real = realOptions[qname]
      if (!setting) continue // e.g. a key that no longer exists -- not this test's job to flag
      if (!real) continue // StrongEnumSandboxOption entries -- no ground truth to compare, correctly allowlisted
      const stillDiffers =
        (setting.type === 'number' && real.type !== 'integer' && real.type !== 'double') ||
        (setting.type === 'select' && real.type !== 'enum') ||
        (setting.type === 'number' && typeof setting.max === 'number' && Math.abs(setting.max - real.max) > EPSILON) ||
        (setting.type === 'number' && typeof setting.min === 'number' && Math.abs(setting.min - real.min) > EPSILON)
      if (!stillDiffers) staleEntries.push(qname)
    }
    expect(staleEntries, 'allowlist entries that now match the fixture exactly -- remove them so they keep guarding against a real future regression').toEqual([])
  })
})
