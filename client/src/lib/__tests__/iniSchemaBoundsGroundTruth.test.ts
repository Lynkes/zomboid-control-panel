import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INI_SCHEMA } from '../serverConfigSchema'

// The INI counterpart of sandboxSchemaBoundsGroundTruth.test.ts: gates
// INI_SCHEMA's numeric min/max/default (and enum-backed select options)
// against server/__fixtures__/pzServerOptions.json, which is read straight
// out of zombie.network.ServerOptions' constructor bytecode in the real B42
// jar. Regenerate with:
//   node scripts/jar-audit/extract-server-options.mjs <path-to-projectzomboid.jar>
//
// GH#182: VoiceMaxDistance was capped at 1000 here while the game takes
// 0-100000, so the form refused a radio range the server accepts. The same
// sweep found 15 more drifted fields (MaxPlayers capped at 100 vs
// 254, PingLimit's min of 100 rejecting B42's own default of 0, SpeedLimit
// and MaxPacketsPerSecond wider than the game, BadWordPolicy offering a 4th
// value the game ignores, ...). PZ does not clamp: an out-of-range .ini
// value is logged and dropped, so drift in either direction loses edits.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, '../../../../server/__fixtures__/pzServerOptions.json')

type RealOption =
  | { type: 'integer' | 'double' | 'enum'; min: number; max: number; default: number; fieldName: string }
  | { type: 'boolean'; default: boolean; fieldName: string }
  | { type: 'string' | 'text'; default: string; maxLength: number; fieldName: string }

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

const EPSILON = 1e-6

// Known, judged-intentional disagreements. Skipped by every comparison
// below; the last test fails if an entry stops disagreeing.
const ALLOWLIST: Record<string, string> = {
  DefaultPort: "2026-10-01: schema min 1024 vs real 0 -- the panel's documented bind-port floor (server/routes/server.js BIND_PORT_MIN, ServerSetup.tsx); tighter than the game, never looser.",
  RCONPort: "2026-10-01: schema min 1024 vs real 0 -- same bind-port floor as DefaultPort; tighter than the game, never looser.",
}

// Numeric INI_SCHEMA entries for Build 41 options that B42's ServerOptions
// no longer declares at all, so there is no ground truth to compare.
const NOT_IN_B42: Record<string, string> = {
  PingFrequency: 'B41-only option; absent from B42 ServerOptions.',
  SteamPort1: 'B41-only option; absent from B42 ServerOptions.',
  SteamPort2: 'B41-only option; absent from B42 ServerOptions.',
  PhysicsDelay: 'B41-only option; absent from B42 ServerOptions.',
  ZombieUpdateMaxHighPriority: 'B41-only option; absent from B42 ServerOptions.',
  ZombieUpdateDelta: 'B41-only option; absent from B42 ServerOptions.',
}

const fixture = loadFixture()
const realOptions = fixture ? fixture.options : {}

function isNumericReal(real: RealOption | undefined): real is Extract<RealOption, { min: number }> {
  return !!real && (real.type === 'integer' || real.type === 'double' || real.type === 'enum')
}

describe('INI_SCHEMA numeric bounds vs the real B42 game (bytecode ground truth)', () => {
  it('the fixture exists and has a substantial option set', () => {
    expect(
      fixture,
      `ground-truth fixture missing or unparseable at ${FIXTURE_PATH} -- run: ` +
        'node scripts/jar-audit/extract-server-options.mjs <path-to-projectzomboid.jar>',
    ).not.toBeNull()
    // 141 at the time this gate was written.
    expect(Object.keys(realOptions).length, 'fixture has an implausibly small option set').toBeGreaterThan(120)
  })

  it('every numeric INI_SCHEMA entry has a numeric ground-truth option (or is a known B41 leftover)', () => {
    const missing: string[] = []
    for (const setting of INI_SCHEMA) {
      if (setting.type !== 'number') continue
      if (NOT_IN_B42[setting.key]) continue
      const real = realOptions[setting.key]
      if (!real || (real.type !== 'integer' && real.type !== 'double')) missing.push(`${setting.key} (${real ? real.type : 'absent'})`)
    }
    expect(missing).toEqual([])
  })

  it('min/max/default match the real game exactly outside the allowlist', () => {
    const mismatches: Array<{ key: string; field: 'min' | 'max' | 'default'; schema: unknown; real: number }> = []
    let compared = 0
    for (const setting of INI_SCHEMA) {
      if (setting.type !== 'number' || ALLOWLIST[setting.key]) continue
      const real = realOptions[setting.key]
      if (!isNumericReal(real)) continue
      compared++
      for (const field of ['min', 'max', 'default'] as const) {
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
      if (setting.type !== 'select' || !setting.options || ALLOWLIST[setting.key]) continue
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

  it('the allowlist and the B41 list are not stale', () => {
    const stale: string[] = []
    for (const key of Object.keys(ALLOWLIST)) {
      const setting = INI_SCHEMA.find((s) => s.key === key)
      const real = realOptions[key]
      if (!setting || !isNumericReal(real)) { stale.push(key); continue }
      const differs = (['min', 'max', 'default'] as const).some(
        (f) => typeof setting[f] !== 'number' || Math.abs((setting[f] as number) - real[f]) > EPSILON,
      )
      if (!differs) stale.push(key)
    }
    for (const key of Object.keys(NOT_IN_B42)) {
      if (realOptions[key] || !INI_SCHEMA.some((s) => s.key === key)) stale.push(key)
    }
    expect(stale, 'entries that now match the fixture (or no longer exist) -- remove them').toEqual([])
  })
})
