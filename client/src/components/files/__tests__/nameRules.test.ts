import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAME_RULE_REASONS } from '@/types/files'
import enFiles from '@/locales/en/files.json'
import { validateName, validateSegments } from '../nameRules'

// nameRules.ts mirrors validateSegments()/validateName() in
// server/services/fileManagerContract.js so the dialogs refuse a name with
// the reason the server would. Both sides run this same fixture
// (server/tests/fileManagerContractParity.test.js runs the server's), read
// from disk rather than copied, so a case added there lands here too.

interface NameCase {
  input: string
  kind: 'path' | 'name' | 'newName'
  reason: string | null
}

const fixturePath = path.resolve(process.cwd(), '../server/tests/fixtures/fileManagerNameCases.json')
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as NameCase[]

function check(testCase: NameCase): string | null {
  const result = testCase.kind === 'path'
    ? validateSegments(testCase.input)
    : validateName(testCase.input, { isNew: testCase.kind === 'newName' })
  return result.ok ? null : result.reason
}

describe('nameRules.ts parity with the shared fixture', () => {
  it('reads a fixture that covers every reason', () => {
    expect(cases.length).toBeGreaterThan(50)
    const covered = new Set(cases.map((c) => c.reason).filter(Boolean))
    for (const reason of NAME_RULE_REASONS) expect(covered.has(reason), reason).toBe(true)
  })

  it.each(cases.map((c, index) => [index, c.kind, JSON.stringify(c.input).slice(0, 60), c] as const))(
    'case %i (%s %s)',
    (_index, _kind, _label, testCase) => {
      expect(check(testCase)).toBe(testCase.reason)
    },
  )

  it('returns the segments of a valid path, and [] for the root', () => {
    expect(validateSegments('')).toEqual({ ok: true, segments: [] })
    expect(validateSegments('Server/servertest.ini')).toEqual({ ok: true, segments: ['Server', 'servertest.ini'] })
  })

  it('has an en message for every reason it can return', () => {
    for (const reason of NAME_RULE_REASONS) {
      expect(typeof (enFiles.nameRules as Record<string, string>)[reason], reason).toBe('string')
    }
  })
})
