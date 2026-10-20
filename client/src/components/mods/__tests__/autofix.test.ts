import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ModHealth, type ModHealthIssue } from '@/lib/api'
import type { ConflictPair } from '@/types'
import { buildAutofixPreview, candidateRules, defaultChecked, openConflictCount, removedMods, runAutofix, runOrder, type AutofixApi } from '../autofix'

const ref = (modId: string, ws = '1') => ({ workshopId: ws, modId, modName: modId })
function pair(a: string, b: string, opts: { high?: number; medium?: number; low?: number; suggestion?: ConflictPair['suggestion']; ws?: [string, string]; files?: object[] } = {}): ConflictPair {
  return {
    modA: ref(a, opts.ws?.[0]),
    modB: ref(b, opts.ws?.[1]),
    files: (opts.files ?? [{ file: 'lua/client/x.lua', category: 'lua', severity: 'high', kind: 'lua-override' }]) as ConflictPair['files'],
    highCount: opts.high ?? 1,
    mediumCount: opts.medium ?? 0,
    lowCount: opts.low ?? 0,
    ...(opts.suggestion ? { suggestion: opts.suggestion } : {}),
  }
}
const suggest = (winner: string, confidence: 'high' | 'medium' | 'low', alreadyWinning = false) => ({ winner, confidence, reason: 'smallOverride' as const, alreadyWinning })
const issue = (id: string, fixes: ModHealthIssue['fixes']): ModHealthIssue => ({ id, kind: 'mapNotInMapLine', severity: 'warning', modIds: [], workshopIds: [], params: {}, fixes })
const health = (issues: ModHealthIssue[]): ModHealth => ({ checkedAt: '', counts: { critical: 0, warning: issues.length, info: 0 }, issues, steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 } })

describe('buildAutofixPreview', () => {
  const pairs = [
    pair('Big', 'Small', { suggestion: suggest('Small', 'medium') }),
    pair('Lib', 'Addon', { suggestion: suggest('Addon', 'high', true) }),
    pair('X', 'Y', { suggestion: suggest('Y', 'low') }),
    pair('P', 'Q'),
    pair('Low1', 'Low2', { high: 0, low: 3, suggestion: suggest('Low2', 'high') }),
    pair('Pinned', 'Other', { suggestion: suggest('Other', 'high') }),
  ]
  const input = {
    health: health([
      issue('i1', [{ action: 'addMapFolders', params: { folders: ['Bunker'] }, label: '' }]),
      issue('i2', [{ action: 'removeMods', params: { modIds: ['Old'] }, label: '' }, { action: 'removeMods', params: { modIds: ['New'] }, label: '' }]),
      issue('i3', [{ action: 'applyPlan', params: {}, label: '' }]),
    ]),
    pairs,
    rules: [{ id: 'r1', before: 'Pinned', after: 'Other', note: '', source: 'manual' as const, createdBy: null, createdAt: null }],
    groups: [],
    isPairIgnored: () => false,
  }

  it('checks the safe fixes, the sure suggestions not winning yet and the plan; lists removals unchecked and unsure pairs for review', () => {
    const preview = buildAutofixPreview(input)
    expect(preview.fixes.map((i) => i.id)).toEqual(['fix:i1:addMapFolders'])
    expect(preview.removals.map((i) => i.id)).toEqual(['fix:i2:removeMods:0', 'fix:i2:removeMods:1'])
    expect(preview.rules.map((i) => i.id)).toEqual(['rule:Big>Small', 'rule:Low1>Low2'])
    expect(preview.review.map((r) => r.key)).toEqual(['X--Y', 'P--Q'])
    const checked = defaultChecked(preview)
    expect([...checked].sort()).toEqual(['fix:i1:addMapFolders', 'plan', 'rule:Big>Small', 'rule:Low1>Low2'])
    expect(candidateRules(preview, checked)).toEqual([['Big', 'Small'], ['Low1', 'Low2']])
    expect(runOrder(preview, new Set([...checked, 'fix:i2:removeMods:1'])).map((i) => i.id))
      .toEqual(['fix:i1:addMapFolders', 'fix:i2:removeMods:1', 'rule:Big>Small', 'rule:Low1>Low2', 'plan'])
  })

  it('offers disabling a true variant (both enabled, same item, neither needs the other), never an add-on', () => {
    const preview = buildAutofixPreview({
      ...input,
      health: null,
      pairs: [
        pair('TexDOLL', 'TexNUDE', { ws: ['9', '9'] }),
        pair('Base', 'BaseAddon', { ws: ['9', '9'] }),
      ],
      groups: [{ wsId: '9', mods: [{ id: 'TexDOLL', enabled: true }, { id: 'TexNUDE', enabled: true }, { id: 'Base', enabled: true }, { id: 'BaseAddon', enabled: true, require: ['Base'] }] }],
    })
    expect(preview.removals.map((i) => i.id)).toEqual(['variant:TexDOLL', 'variant:TexNUDE'])
    expect(removedMods(preview, new Set(['variant:TexNUDE']))).toEqual(new Set(['TexNUDE']))
  })
})

describe('openConflictCount', () => {
  const pairs = [
    pair('A', 'B', { suggestion: suggest('B', 'high') }),
    pair('C', 'D', { suggestion: suggest('D', 'medium', true) }),
    pair('E', 'F'),
    pair('G', 'H', { high: 0, low: 1 }),
  ]
  it('counts higher-impact pairs whose sure suggestion does not win yet', () => {
    expect(openConflictCount(pairs)).toBe(2)
    expect(openConflictCount(pairs, { order: ['A', 'C', 'D', 'B'] })).toBe(1)
    expect(openConflictCount(pairs, { order: ['A', 'C', 'D', 'B'], removed: new Set(['E']) })).toBe(0)
  })
})

describe('runAutofix', () => {
  const preview = buildAutofixPreview({
    health: health([issue('i1', [{ action: 'addMapFolders', params: { folders: ['Bunker'] }, label: '' }]), issue('i2', [{ action: 'addMods', params: { modIds: ['M'] }, label: '' }])]),
    pairs: [pair('Big', 'Small', { suggestion: suggest('Small', 'medium') }), pair('U', 'V', { suggestion: suggest('V', 'high') })],
    rules: [],
    groups: [],
    isPairIgnored: () => false,
  })
  const items = runOrder(preview, defaultChecked(preview))

  function api(overrides: Partial<AutofixApi> = {}): AutofixApi & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      snapshot: vi.fn(async () => { calls.push('snapshot'); return { snapshotId: 's1' } }),
      applyHealthFix: vi.fn(async (issueArg) => { calls.push(`fix:${issueArg.id}`); return { applied: true, health: health([]) } }),
      disableMod: vi.fn(async (modId) => { calls.push(`disable:${modId}`) }),
      addRule: vi.fn(async (rule) => { calls.push(`rule:${rule.before}>${rule.after}`); return { rule: { id: `id-${rule.after}`, ...rule, note: '', source: 'conflictResolve' as const, createdBy: null, createdAt: null }, existing: rule.after === 'V' } }),
      plan: vi.fn(async () => { calls.push('plan'); return { order: ['Big', 'Small'], changed: true, moves: [{ modId: 'Small' }, { modId: 'X' }] } as never }),
      saveOrder: vi.fn(async (order) => { calls.push(`save:${order.join(',')}`) }),
      ...overrides,
    }
  }

  it('snapshots first, then fixes, rules and the plan saved through save-order; keeps only the rules it added', async () => {
    const a = api()
    const result = await runAutofix(items, a, () => {})
    expect(a.calls).toEqual(['snapshot', 'fix:i1', 'fix:i2', 'rule:Big>Small', 'rule:U>V', 'plan', 'save:Big,Small'])
    expect(result).toMatchObject({ snapshotId: 's1', applied: 5, skipped: 0, moved: 2, addedRuleIds: ['id-Small'], failed: null })
  })

  it('counts a fix an earlier step solved as skipped, and stops at the first real error', async () => {
    const gone = new ApiError('gone')
    gone.code = 'MODS_HEALTH_ISSUE_GONE'
    const cycle = new ApiError('loop')
    cycle.code = 'MODS_ORDER_RULE_CYCLE'
    const a = api({
      applyHealthFix: vi.fn(async (issueArg) => { if (issueArg.id === 'i1') throw gone; return { applied: true, health: health([]) } }),
      addRule: vi.fn(async () => { throw cycle }),
    })
    const result = await runAutofix(items, a, () => {})
    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(1)
    expect(result.failed?.item?.id).toBe('rule:Big>Small')
    expect(a.plan).not.toHaveBeenCalled()
    expect(result.snapshotId).toBe('s1')
  })
})
