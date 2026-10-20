import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { modsApi, type LoadOrderPlan } from '@/lib/api'
import type { ConflictPair } from '@/types'
import {
  CURRENT_PLAN_DEBOUNCE_MS,
  explanationsOf,
  planCacheKey,
  planConflictPairs,
  useCurrentPlan,
  useSmartSort,
} from '../useLoadOrderPlan'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, modsApi: { ...actual.modsApi, planLoadOrder: vi.fn() } }
})

const planLoadOrder = vi.mocked(modsApi.planLoadOrder)

function plan(order: string[], extra: Partial<LoadOrderPlan> = {}): LoadOrderPlan {
  return {
    order,
    changed: false,
    moves: [],
    explanations: {},
    satisfied: 0,
    unsatisfied: [],
    cycles: [],
    winnersChanged: [],
    implicit: [],
    warnings: [],
    stats: { constraints: 0, hard: 0, strong: 0, soft: 0, ms: 1 },
    steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
    ...extra,
  }
}

const pair = (a: string, b: string, files: Array<Partial<ConflictPair['files'][number]>>): ConflictPair => ({
  modA: { workshopId: '1', modId: a, modName: a },
  modB: { workshopId: '2', modId: b, modName: b },
  files: files.map((f) => ({ file: 'x.lua', category: 'lua', severity: 'medium', ...f })) as ConflictPair['files'],
  highCount: 0,
  mediumCount: 1,
  lowCount: 0,
})

afterEach(() => {
  vi.useRealTimers()
  planLoadOrder.mockReset()
})

describe('planConflictPairs', () => {
  it('passes only real conflicts: no intended overrides, no declared incompatibility', () => {
    const conflicts = {
      pairs: [
        pair('a', 'b', [{ severity: 'high' }]),
        pair('c', 'd', [{ severity: 'info' }]),
        pair('e', 'f', [{ severity: 'medium', intended: true }]),
        pair('g', 'h', [{ severity: 'low', kind: 'declared-incompatible' }]),
        pair('i', 'j', [{ severity: 'info' }, { severity: 'low' }]),
      ],
    }
    expect(planConflictPairs(conflicts, false)).toEqual([['a', 'b'], ['i', 'j']])
  })

  it('passes none while the cached scan is stale or for another server', () => {
    expect(planConflictPairs({ pairs: [pair('a', 'b', [{ severity: 'high' }])] }, true)).toEqual([])
    expect(planConflictPairs(null, false)).toEqual([])
  })
})

describe('planCacheKey / explanationsOf', () => {
  it('keys an order and its version, stable and order-sensitive', () => {
    expect(planCacheKey(['a', 'b'], 'v1')).toBe(planCacheKey(['a', 'b'], 'v1'))
    expect(planCacheKey(['a', 'b'], 'v1')).not.toBe(planCacheKey(['b', 'a'], 'v1'))
    expect(planCacheKey(['a', 'b'], 'v1')).not.toBe(planCacheKey(['a', 'b'], 'v2'))
  })

  it('reads own explanations only ("constructor" is a mod ID too)', () => {
    const p = plan(['constructor'], { explanations: Object.assign(Object.create(null), { a: [{ code: 'rule', params: {} }] }) })
    expect(explanationsOf(p, 'constructor')).toEqual([])
    expect(explanationsOf(p, 'a')).toHaveLength(1)
  })
})

describe('useCurrentPlan', () => {
  it('plans the order on screen after the debounce, once per order, and caches answers', async () => {
    vi.useFakeTimers()
    planLoadOrder.mockImplementation(async (request) => plan(request?.order ?? []))
    const { result, rerender } = renderHook((props: { order: string[] }) => useCurrentPlan({ order: props.order, enabled: true, version: 'v', conflictPairs: [] }), {
      initialProps: { order: ['a', 'b'] },
    })
    rerender({ order: ['b', 'a'] })
    expect(planLoadOrder).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(CURRENT_PLAN_DEBOUNCE_MS) })
    // Only the last order of a burst is planned.
    expect(planLoadOrder).toHaveBeenCalledTimes(1)
    expect(planLoadOrder.mock.calls[0][0]).toMatchObject({ order: ['b', 'a'], mode: 'minimal', groups: true, conflictPairs: [] })
    expect(result.current.fresh).toBe(true)

    rerender({ order: ['a', 'b'] })
    await act(async () => { await vi.advanceTimersByTimeAsync(CURRENT_PLAN_DEBOUNCE_MS) })
    rerender({ order: ['b', 'a'] })
    // Back to a planned order: answered from the cache at once.
    expect(result.current.fresh).toBe(true)
    expect(result.current.plan?.order).toEqual(['b', 'a'])
    expect(planLoadOrder).toHaveBeenCalledTimes(2)
  })

  it('cancels an older request when the order changes again', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    planLoadOrder.mockImplementation((_request, options) => {
      if (options?.signal) signals.push(options.signal)
      return new Promise(() => {})
    })
    const { rerender } = renderHook((props: { order: string[] }) => useCurrentPlan({ order: props.order, enabled: true, version: 'v', conflictPairs: [] }), {
      initialProps: { order: ['a', 'b'] },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(CURRENT_PLAN_DEBOUNCE_MS) })
    rerender({ order: ['b', 'a'] })
    await act(async () => { await vi.advanceTimersByTimeAsync(CURRENT_PLAN_DEBOUNCE_MS) })
    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  it('asks nothing while disabled', async () => {
    vi.useFakeTimers()
    renderHook(() => useCurrentPlan({ order: ['a'], enabled: false, version: 'v', conflictPairs: [] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(CURRENT_PLAN_DEBOUNCE_MS * 2) })
    expect(planLoadOrder).not.toHaveBeenCalled()
  })
})

describe('useSmartSort', () => {
  it('plans the unsaved order with the pairs given, re-plans tiered, and keeps the input for Apply', async () => {
    localStorage.removeItem('zcp:mods:order:tieredSort')
    planLoadOrder.mockImplementation(async (request) => plan([...(request?.order ?? [])].reverse(), { changed: true }))
    const onError = vi.fn()
    const pairs: [string, string][] = [['a', 'b']]
    const { result } = renderHook(() => useSmartSort({ conflictPairs: pairs, onError }))
    await act(async () => { await result.current.open(['a', 'b', 'c']) })
    expect(planLoadOrder.mock.calls[0][0]).toEqual({ order: ['a', 'b', 'c'], mode: 'minimal', groups: true, conflictPairs: pairs })
    expect(result.current.preview?.input).toEqual(['a', 'b', 'c'])
    expect(result.current.preview?.plan.order).toEqual(['c', 'b', 'a'])

    await act(async () => { result.current.setMode('tiered') })
    expect(planLoadOrder.mock.calls[1][0]).toMatchObject({ order: ['a', 'b', 'c'], mode: 'tiered' })
    expect(result.current.tiered).toBe(true)

    act(() => result.current.close())
    expect(result.current.preview).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a failed plan and opens nothing', async () => {
    planLoadOrder.mockRejectedValue(new Error('boom'))
    const onError = vi.fn()
    const { result } = renderHook(() => useSmartSort({ conflictPairs: [], onError }))
    await act(async () => { await result.current.open(['a']) })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(result.current.preview).toBeNull()
    expect(result.current.busy).toBe(false)
  })
})
