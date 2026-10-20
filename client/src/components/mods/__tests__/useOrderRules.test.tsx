import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { ApiError, modsApi, type ModOrderRule } from '@/lib/api'
import { findOppositeRule, findSameRule, useOrderRules } from '../useOrderRules'

// The pinned order store: the rules read once when enabled, read again after
// every add and delete, an index by mod for "rules naming this mod", and a
// stale answer never overwriting a newer one.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      getOrderRules: vi.fn(),
      addOrderRule: vi.fn(),
      deleteOrderRule: vi.fn(),
    },
  }
})

const getOrderRules = vi.mocked(modsApi.getOrderRules)
const addOrderRule = vi.mocked(modsApi.addOrderRule)
const deleteOrderRule = vi.mocked(modsApi.deleteOrderRule)

const rule = (id: string, before: string, after: string, extra: Partial<ModOrderRule> = {}): ModOrderRule => ({
  id, before, after, note: '', source: 'manual', createdBy: 'admin', createdAt: '2026-10-20T10:00:00.000Z', ...extra,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  for (const mock of [getOrderRules, addOrderRule, deleteOrderRule]) mock.mockReset()
})

describe('useOrderRules', () => {
  it('reads nothing while disabled, then the rules and the cap once enabled', async () => {
    getOrderRules.mockResolvedValue({ rules: [rule('r1', 'TchernoLib', 'Brita')], max: 50 })
    const { result, rerender } = renderHook(({ enabled }) => useOrderRules({ enabled }), { initialProps: { enabled: false } })
    expect(result.current.loadState).toBe('idle')
    expect(getOrderRules).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.rules.map((r) => r.id)).toEqual(['r1'])
    expect(result.current.max).toBe(50)
  })

  it('indexes the rules by both mods they name', async () => {
    getOrderRules.mockResolvedValue({
      rules: [rule('r1', 'TchernoLib', 'Brita'), rule('r2', 'Brita', 'Brita_2'), rule('r3', 'KI5Library', 'KI5Fixes')],
      max: 2000,
    })
    const { result } = renderHook(() => useOrderRules({ enabled: true }))
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.rulesFor('Brita').map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(result.current.rulesFor('KI5Fixes').map((r) => r.id)).toEqual(['r3'])
    expect(result.current.rulesFor('Nobody')).toEqual([])
  })

  it('adds a rule and reads the rules again; a refusal is passed on and changes nothing', async () => {
    getOrderRules.mockResolvedValueOnce({ rules: [], max: 2000 })
    const { result } = renderHook(() => useOrderRules({ enabled: true }))
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    const stored = rule('r9', 'KI5_M35A2', 'KI5Fixes', { source: 'conflictResolve' })
    addOrderRule.mockResolvedValueOnce({ rule: stored, existing: false, replaced: [] })
    getOrderRules.mockResolvedValueOnce({ rules: [stored], max: 2000 })
    await act(async () => {
      await result.current.add({ before: 'KI5_M35A2', after: 'KI5Fixes', source: 'conflictResolve' })
    })
    expect(addOrderRule).toHaveBeenCalledWith({ before: 'KI5_M35A2', after: 'KI5Fixes', source: 'conflictResolve' })
    expect(result.current.rules).toEqual([stored])

    addOrderRule.mockRejectedValueOnce(new ApiError('loop', { status: 409, code: 'MODS_ORDER_RULE_CYCLE' }))
    await expect(result.current.add({ before: 'KI5Fixes', after: 'KI5_M35A2' })).rejects.toBeInstanceOf(ApiError)
    expect(getOrderRules).toHaveBeenCalledTimes(2)
    expect(result.current.rules).toEqual([stored])
  })

  it('removes a rule at once and reads the rules again', async () => {
    getOrderRules.mockResolvedValueOnce({ rules: [rule('r1', 'A', 'B'), rule('r2', 'C', 'D')], max: 2000 })
    const { result } = renderHook(() => useOrderRules({ enabled: true }))
    await waitFor(() => expect(result.current.rules).toHaveLength(2))

    deleteOrderRule.mockResolvedValueOnce({ success: true })
    getOrderRules.mockResolvedValueOnce({ rules: [rule('r2', 'C', 'D')], max: 2000 })
    await act(async () => {
      await result.current.remove('r1')
    })
    expect(deleteOrderRule).toHaveBeenCalledWith('r1')
    expect(result.current.rules.map((r) => r.id)).toEqual(['r2'])
  })

  it('drops an older answer that lands after a newer one', async () => {
    let finishFirst!: (value: { rules: ModOrderRule[]; max: number }) => void
    getOrderRules.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
    const { result } = renderHook(() => useOrderRules({ enabled: true }))

    getOrderRules.mockResolvedValueOnce({ rules: [rule('new', 'A', 'B')], max: 2000 })
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.rules.map((r) => r.id)).toEqual(['new'])

    await act(async () => {
      finishFirst({ rules: [rule('old', 'X', 'Y')], max: 2000 })
    })
    expect(result.current.rules.map((r) => r.id)).toEqual(['new'])
  })

  it('finds the same rule and the opposite rule', () => {
    const rules = [rule('r1', 'A', 'B')]
    expect(findSameRule(rules, 'A', 'B')?.id).toBe('r1')
    expect(findOppositeRule(rules, 'B', 'A')?.id).toBe('r1')
    expect(findOppositeRule(rules, 'A', 'B')).toBeUndefined()
  })
})
