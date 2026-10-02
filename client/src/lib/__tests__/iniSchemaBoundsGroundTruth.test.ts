import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INI_SCHEMA, type IniSetting } from '../serverConfigSchema'

// The INI counterpart of sandboxSchemaBoundsGroundTruth.test.ts: gates
// INI_SCHEMA against server/__fixtures__/pzServerOptions.json, which is read
// straight out of zombie.network.ServerOptions' constructor bytecode in the
// real B42 jar -- which keys exist, each one's option type, numeric
// min/max/default, boolean defaults, and enum-backed select options.
// Regenerate with:
//   node scripts/jar-audit/extract-server-options.mjs <path-to-projectzomboid.jar>
//
// GH#182: VoiceMaxDistance was capped at 1000 here while the game takes
// 0-100000, so the form refused a radio range the server accepts. The same
// sweep found 15 more drifted fields (MaxPlayers capped at 100 vs
// 254, PingLimit's min of 100 rejecting B42's own default of 0, SpeedLimit
// and MaxPacketsPerSecond wider than the game, BadWordPolicy offering a 4th
// value the game ignores, ...). PZ does not clamp: an out-of-range .ini
// value is logged and dropped, so drift in either direction loses edits.
// The follow-up sweep found the non-numeric side: Public and PlayerSafehouse
// defaulting to true (the game says false), SteamScoreboard offered as a
// true/false/admin select (B42 declares a BooleanServerOption, whose parser
// takes only true/false/1/0), twelve Build 41 keys B42 no longer declares,
// and ShowCoordinates missing.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, '../../../../server/__fixtures__/pzServerOptions.json')

type RealOption =
  | { type: 'integer' | 'double' | 'enum'; min: number; max: number; default: number; fieldName: string }
  | { type: 'boolean'; default: boolean; fieldName: string }
  | { type: 'string' | 'text'; default: string; maxLength: number; fieldName: string }

type Fixture = {
  _provenance: { skipped?: Array<{ name: string; kind: string; reason: string }> } & Record<string, unknown>
  options: Record<string, RealOption>
}

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

const EPSILON = 1e-6
type NumericField = 'min' | 'max' | 'default'

// Known, judged-intentional disagreements, per field: only the listed
// fields are skipped, so the rest of the entry is still compared. The
// staleness test fails if a listed field stops disagreeing.
const ALLOWLIST: Record<string, { fields: NumericField[]; reason: string }> = {
  DefaultPort: {
    fields: ['min'],
    reason: "2026-10-01: schema min 1024 vs real 0 -- the panel's documented bind-port floor (server/routes/server.js BIND_PORT_MIN, ServerSetup.tsx); tighter than the game, never looser.",
  },
  RCONPort: {
    fields: ['min'],
    reason: '2026-10-01: schema min 1024 vs real 0 -- same bind-port floor as DefaultPort; tighter than the game, never looser.',
  },
}

// 42.21 ServerOptions the form deliberately does not offer.
const NOT_IN_FORM: Record<string, string> = {
  BloodSplatLifespanDays:
    "2026-10-01: declared by 42.21's ServerOptions but never read -- IsoChunk and IsoObject read SandboxOptions.bloodSplatLifespanDays, and PZ's own Server Settings screen only offers the sandbox one. SANDBOX_SCHEMA's entry is the setting that works; ServerConfig.tsx keeps the dead .ini line out of its unknown-keys list.",
}

const fixture = loadFixture()
const realOptions = fixture ? fixture.options : {}
// Options whose default the game computes at runtime (ResetID,
// ServerPlayerID, Seed): real ServerOptions the extractor can't read a
// constant default for, so they are listed under _provenance.skipped.
const computedOptions = new Set((fixture?._provenance.skipped ?? []).map((s) => s.name))

function isNumericReal(real: RealOption | undefined): real is Extract<RealOption, { min: number }> {
  return !!real && (real.type === 'integer' || real.type === 'double' || real.type === 'enum')
}

function existsInGame(key: string): boolean {
  return key in realOptions || computedOptions.has(key)
}

// Which INI_SCHEMA input types can faithfully edit each game option type.
// An integer can be a select (MapRemotePlayerVisibility lists its 1-4
// values); a boolean must be a switch, never a select.
const COMPATIBLE_TYPES: Record<RealOption['type'], ReadonlyArray<IniSetting['type']>> = {
  boolean: ['boolean'],
  integer: ['number', 'select'],
  double: ['number'],
  enum: ['select'],
  string: ['string', 'multiline', 'filepath'],
  text: ['string', 'multiline'],
}

describe('INI_SCHEMA vs the real B42 game (bytecode ground truth)', () => {
  it('the fixture exists and has a substantial option set', () => {
    expect(
      fixture,
      `ground-truth fixture missing or unparseable at ${FIXTURE_PATH} -- run: ` +
        'node scripts/jar-audit/extract-server-options.mjs <path-to-projectzomboid.jar>',
    ).not.toBeNull()
    // 141 at the time this gate was written.
    expect(Object.keys(realOptions).length, 'fixture has an implausibly small option set').toBeGreaterThan(120)
    expect([...computedOptions].sort()).toEqual(['ResetID', 'Seed', 'ServerPlayerID'])
  })

  it('every INI_SCHEMA key is a B42 option unless it is marked legacy, and no legacy key is one', () => {
    const notInGame: string[] = []
    const wronglyLegacy: string[] = []
    for (const setting of INI_SCHEMA) {
      const inGame = existsInGame(setting.key)
      if (!inGame && !setting.legacy) notInGame.push(setting.key)
      if (inGame && setting.legacy) wronglyLegacy.push(setting.key)
    }
    expect(
      notInGame,
      "keys the B42 game doesn't declare -- mark them `legacy: true` (shown only when a file has them, never added to one) or remove them",
    ).toEqual([])
    expect(wronglyLegacy, 'marked legacy but the B42 game declares them').toEqual([])
  })

  it('the twelve Build 41 leftovers are the legacy set', () => {
    expect(INI_SCHEMA.filter((s) => s.legacy).map((s) => s.key).sort()).toEqual([
      'AllowTradeUI',
      'DiscordChannel',
      'DiscordChannelID',
      'KickFastPlayers',
      'PhysicsDelay',
      'PingFrequency',
      'PlayerSaveOnDamage',
      'SteamPort1',
      'SteamPort2',
      'UseTCPForMapDownloads',
      'ZombieUpdateDelta',
      'ZombieUpdateMaxHighPriority',
    ])
  })

  it('every B42 option is in INI_SCHEMA, or deliberately left out of the form', () => {
    const schemaKeys = new Set(INI_SCHEMA.map((s) => s.key))
    const missing = [...Object.keys(realOptions), ...computedOptions].filter(
      (key) => !schemaKeys.has(key) && !NOT_IN_FORM[key],
    )
    expect(missing, 'add these to INI_SCHEMA (labels in all 10 locales) or to NOT_IN_FORM with a reason').toEqual([])
  })

  it("each entry's input type can hold the game option's values", () => {
    const mismatches: string[] = []
    for (const setting of INI_SCHEMA) {
      const real = realOptions[setting.key]
      if (!real) continue
      if (!COMPATIBLE_TYPES[real.type].includes(setting.type)) {
        mismatches.push(`${setting.key}: schema ${setting.type}, game ${real.type}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('boolean defaults match the real game exactly', () => {
    const mismatches: Array<{ key: string; schema: unknown; real: boolean }> = []
    let compared = 0
    for (const setting of INI_SCHEMA) {
      const real = realOptions[setting.key]
      if (setting.type !== 'boolean' || real?.type !== 'boolean') continue
      compared++
      if (setting.default !== real.default) mismatches.push({ key: setting.key, schema: setting.default, real: real.default })
    }
    expect(compared).toBeGreaterThan(70)
    expect(mismatches, 'the form shows this default for a key the file lacks, and flags anything else as non-default').toEqual([])
  })

  it('min/max/default match the real game exactly outside the allowlist', () => {
    const mismatches: Array<{ key: string; field: NumericField; schema: unknown; real: number }> = []
    let compared = 0
    for (const setting of INI_SCHEMA) {
      if (setting.type !== 'number') continue
      const real = realOptions[setting.key]
      if (!isNumericReal(real)) continue
      compared++
      const skipped = ALLOWLIST[setting.key]?.fields ?? []
      for (const field of ['min', 'max', 'default'] as const) {
        if (skipped.includes(field)) continue
        const schemaValue = setting[field]
        if (typeof schemaValue !== 'number' || Math.abs(schemaValue - real[field]) > EPSILON) {
          mismatches.push({ key: setting.key, field, schema: schemaValue, real: real[field] })
        }
      }
    }
    expect(compared).toBeGreaterThan(30)
    expect(
      mismatches,
      'INI_SCHEMA disagrees with the game -- looser lets the panel write a value PZ drops on load; tighter blocks a value PZ accepts (GH#182)',
    ).toEqual([])
  })

  it('the issue #182 field allows the full radio range the game accepts', () => {
    const voiceMax = INI_SCHEMA.find((s) => s.key === 'VoiceMaxDistance')!
    const voiceMin = INI_SCHEMA.find((s) => s.key === 'VoiceMinDistance')!
    expect([voiceMax.min, voiceMax.max, voiceMax.default]).toEqual([0, 100000, 100])
    expect([voiceMin.min, voiceMin.max, voiceMin.default]).toEqual([0, 100000, 10])
  })

  it('select entries backed by a numeric game option offer exactly the values the game accepts', () => {
    const mismatches: Array<{ key: string; issue: string; value: string }> = []
    let compared = 0
    for (const setting of INI_SCHEMA) {
      if (setting.type !== 'select' || !setting.options) continue
      const real = realOptions[setting.key]
      if (!isNumericReal(real)) continue
      compared++
      const accepted = new Set<string>()
      for (let v = real.min; v <= real.max; v++) accepted.add(String(v))
      for (const opt of setting.options) {
        if (!accepted.has(opt.value)) mismatches.push({ key: setting.key, issue: 'offered but rejected by the game', value: opt.value })
      }
      for (const v of accepted) {
        if (!setting.options.some((o) => o.value === v)) mismatches.push({ key: setting.key, issue: 'accepted by the game but not offered', value: v })
      }
      if (String(setting.default) !== String(real.default)) mismatches.push({ key: setting.key, issue: 'default differs', value: String(setting.default) })
    }
    expect(compared).toBeGreaterThan(5)
    expect(mismatches).toEqual([])
  })

  it('the allowlist and the left-out list are not stale', () => {
    const stale: string[] = []
    for (const [key, { fields }] of Object.entries(ALLOWLIST)) {
      const setting = INI_SCHEMA.find((s) => s.key === key)
      const real = realOptions[key]
      if (!setting || !isNumericReal(real)) { stale.push(key); continue }
      for (const field of fields) {
        const schemaValue = setting[field]
        if (typeof schemaValue === 'number' && Math.abs(schemaValue - real[field]) <= EPSILON) stale.push(`${key}.${field}`)
      }
    }
    for (const key of Object.keys(NOT_IN_FORM)) {
      if (!realOptions[key] || INI_SCHEMA.some((s) => s.key === key)) stale.push(key)
    }
    expect(stale, 'entries that now match the fixture (or no longer exist) -- remove them').toEqual([])
  })
})
