import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ModHealth, type ServerProblem } from '@/lib/api'
import { buildFixAllPreview, groupFindings, resolveHealthFix, runFixAll, undoFixAll, type ActionFix } from '../problemFixes'

const HEALTH = {
  checkedAt: '',
  counts: { critical: 1, warning: 1, info: 0 },
  issues: [
    {
      id: 'requiredNotInstalled-aaaaaaaaaaaaaaaa',
      kind: 'requiredNotInstalled',
      severity: 'critical',
      modIds: ['Brita'],
      workshopIds: ['111'],
      params: { missing: 'Arsenal', requiredBy: ['Brita'] },
      fixes: [{ action: 'addWorkshopItems', params: { workshopIds: ['222'] }, label: 'Add Workshop item 222' }],
    },
    {
      id: 'unusedWorkshopItem-bbbbbbbbbbbbbbbb',
      kind: 'unusedWorkshopItem',
      severity: 'info',
      modIds: [],
      workshopIds: ['333'],
      params: { workshopId: '333' },
      fixes: [{ action: 'removeWorkshopItems', params: { workshopIds: ['333'] }, label: 'Remove Workshop item 333' }],
    },
  ],
} as unknown as ModHealth

const healthFix = (params: Record<string, unknown>): ActionFix => ({
  id: 'modsHealth', type: 'action', action: 'modsHealthFix', params, capability: 'mods.manage', safe: true, confirm: false, undo: true,
})

function finding(id: string, fixes: ServerProblem['fixes'], extra: Partial<ServerProblem> = {}): ServerProblem {
  return {
    id, kind: 'other', category: 'server', severity: 'warning', source: 'game', count: 1, firstSeen: null, lastSeen: null, timesFromLog: false,
    message: null, cause: '', modId: null, workshopId: null, mod: null, params: {}, samples: [], fixes, ...extra,
  }
}

const memoryFix = (current: number, next: number): ActionFix => ({
  id: 'raiseMemory', type: 'action', action: 'raiseMemory', params: { serverId: 4, currentGb: current, nextGb: next }, capability: 'servers.manage', safe: true, confirm: false, undo: true,
})
const disable: ActionFix = { id: 'disableMod', type: 'action', action: 'disableMod', params: { modId: 'Brita' }, capability: 'mods.manage', safe: false, confirm: true, undo: true }

describe('resolveHealthFix', () => {
  it('finds a missing required mod by the issue\'s params.missing, not only its modIds', () => {
    const r = resolveHealthFix(healthFix({ kinds: ['requiredNotInstalled'], modId: 'Arsenal' }), HEALTH)
    expect(r?.issue.id).toBe('requiredNotInstalled-aaaaaaaaaaaaaaaa')
    expect(r?.fix.action).toBe('addWorkshopItems')
    expect(r?.safe).toBe(true)
  })

  it('marks a removal as not safe and returns null when nothing matches', () => {
    expect(resolveHealthFix(healthFix({ kinds: ['unusedWorkshopItem'], workshopId: '333' }), HEALTH)?.safe).toBe(false)
    expect(resolveHealthFix(healthFix({ kinds: ['notInstalled'], modId: 'Arsenal' }), HEALTH)).toBeNull()
    expect(resolveHealthFix(healthFix({ kinds: ['requiredNotInstalled'] }), HEALTH)).toBeNull()
  })
})

describe('buildFixAllPreview', () => {
  it('offers the safe fixes once each, leaves the ones that ask to their own buttons and respects capabilities', () => {
    const findings = [
      finding('a', [healthFix({ kinds: ['requiredNotInstalled'], modId: 'Arsenal' })]),
      finding('b', [healthFix({ kinds: ['requiredNotInstalled'], modId: 'Arsenal' })]),
      finding('c', [memoryFix(6, 8)]),
      finding('d', [disable]),
      finding('e', [healthFix({ kinds: ['unusedWorkshopItem'], workshopId: '333' })]),
    ]
    const all = buildFixAllPreview(findings, HEALTH, () => true)
    expect(all.items.map((i) => i.id)).toEqual(['health:requiredNotInstalled-aaaaaaaaaaaaaaaa:addWorkshopItems', 'memory:4'])
    expect(all.needsDecision).toBe(1)
    const modsOnly = buildFixAllPreview(findings, HEALTH, (cap) => cap === 'mods.manage')
    expect(modsOnly.items.map((i) => i.type)).toEqual(['healthFix'])
  })
})

describe('runFixAll', () => {
  const items = buildFixAllPreview([
    finding('a', [healthFix({ kinds: ['requiredNotInstalled'], modId: 'Arsenal' })]),
    finding('c', [memoryFix(6, 8)]),
  ], HEALTH, () => true).items

  it('keeps the mod list first, applies in order and records how to undo the memory change', async () => {
    const calls: string[] = []
    const api = {
      snapshot: vi.fn(async () => { calls.push('snapshot'); return { snapshotId: 's1' } }),
      applyHealthFix: vi.fn(async () => { calls.push('health'); return { applied: true } as never }),
      setMaxMemory: vi.fn(async (_id: string | number, gb: number) => { calls.push(`memory:${gb}`) }),
    }
    const result = await runFixAll(items, api, () => {})
    expect(calls).toEqual(['snapshot', 'health', 'memory:8'])
    expect(result).toMatchObject({ applied: 2, skipped: 0, failed: null, undo: { snapshotId: 's1', memory: [{ serverId: 4, previousGb: 6 }] } })
  })

  it('stops at the first error, and counts a fix Mods health no longer offers as skipped', async () => {
    const setMaxMemory = vi.fn()
    const failing = await runFixAll(items, {
      snapshot: async () => ({ snapshotId: 's2' }),
      applyHealthFix: async () => { throw new Error('disk full') },
      setMaxMemory,
    }, () => {})
    expect(failing.failed?.item?.type).toBe('healthFix')
    expect(setMaxMemory).not.toHaveBeenCalled()
    expect(failing.undo.snapshotId).toBe('s2')

    const gone = await runFixAll(items, {
      snapshot: async () => ({ snapshotId: 's3' }),
      applyHealthFix: async () => { throw new ApiError('gone', { status: 404, code: 'MODS_HEALTH_ISSUE_GONE' }) },
      setMaxMemory: async () => {},
    }, () => {})
    expect(gone).toMatchObject({ applied: 1, skipped: 1, failed: null })
  })

  it('undoes the mod list, then the memory values newest first', async () => {
    const calls: string[] = []
    await undoFixAll({ snapshotId: 's1', memory: [{ serverId: 4, previousGb: 6 }, { serverId: 4, previousGb: 8 }] }, {
      restore: async (id) => { calls.push(`restore:${id}`) },
      setMaxMemory: async (_id, gb) => { calls.push(`memory:${gb}`) },
    })
    expect(calls).toEqual(['restore:s1', 'memory:8', 'memory:6'])
  })
})

describe('groupFindings', () => {
  it('groups by category in the page order and drops empty groups', () => {
    const groups = groupFindings([finding('p', [], { category: 'panel' }), finding('m', [], { category: 'mods' })])
    expect(groups.map((g) => g.category)).toEqual(['mods', 'panel'])
  })
})
