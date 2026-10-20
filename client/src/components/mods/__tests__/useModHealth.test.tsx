import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { modsApi, type ModHealth } from '@/lib/api'
import { useModHealth } from '../useModHealth'

// The health check store: only asks when enabled, asks again when the saved
// Mods= line changes, and never lets an older answer overwrite a newer one.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, modsApi: { ...actual.modsApi, getModHealth: vi.fn(), applyModHealthFix: vi.fn() } }
})

const getModHealth = vi.mocked(modsApi.getModHealth)
const applyModHealthFix = vi.mocked(modsApi.applyModHealthFix)

const STEAM = { source: 'none' as const, fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 }
const health = (checkedAt: string, critical = 0): ModHealth => ({
  checkedAt,
  counts: { critical, warning: 0, info: 0 },
  issues: [],
  steamStatus: STEAM,
})

afterEach(() => {
  vi.clearAllMocks()
  getModHealth.mockReset()
  applyModHealthFix.mockReset()
})

describe('useModHealth', () => {
  it('sends nothing while disabled', () => {
    const { result } = renderHook(() => useModHealth({ enabled: false }))
    expect(getModHealth).not.toHaveBeenCalled()
    expect(result.current.loadState).toBe('idle')
  })

  it('checks again when the refresh key changes, and drops an older answer that lands last', async () => {
    let finishFirst!: (value: ModHealth) => void
    getModHealth
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce(health('second', 1))

    const { result, rerender } = renderHook(({ key }) => useModHealth({ enabled: true, refreshKey: key }), { initialProps: { key: 'a' } })
    expect(getModHealth).toHaveBeenCalledTimes(1)

    rerender({ key: 'b' })
    expect(getModHealth).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.health?.checkedAt).toBe('second'))

    await act(async () => { finishFirst(health('first')) })
    expect(result.current.health?.checkedAt).toBe('second')
    expect(result.current.loadState).toBe('ready')
  })

  it('keeps the error and the last answer apart', async () => {
    getModHealth.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useModHealth({ enabled: true }))
    await waitFor(() => expect(result.current.loadState).toBe('error'))
    expect(result.current.health).toBeNull()
    expect(result.current.error).toBeInstanceOf(Error)
  })

  it('takes the health a fix answers with, over a check still in flight', async () => {
    getModHealth.mockResolvedValueOnce(health('initial', 2))
    const { result } = renderHook(() => useModHealth({ enabled: true }))
    await waitFor(() => expect(result.current.health?.checkedAt).toBe('initial'))

    let finishCheck!: (value: ModHealth) => void
    getModHealth.mockReturnValueOnce(new Promise((resolve) => { finishCheck = resolve }))
    void act(() => { void result.current.reload() })
    applyModHealthFix.mockResolvedValueOnce({ applied: true, health: health('after-fix', 1) })

    const issue = { id: 'b41Only-0000000000000001', kind: 'b41Only' as const, severity: 'warning' as const, modIds: [], workshopIds: [], params: {}, fixes: [] }
    const fix = { action: 'removeMods' as const, params: { modIds: ['OldMod'] }, label: 'Remove OldMod from Mods=' }
    await act(async () => { await result.current.applyFix(issue, fix) })
    expect(applyModHealthFix).toHaveBeenCalledWith(issue.id, 'removeMods', { modIds: ['OldMod'] })
    expect(result.current.health?.checkedAt).toBe('after-fix')

    await act(async () => { finishCheck(health('stale-check', 2)) })
    expect(result.current.health?.checkedAt).toBe('after-fix')
  })
})
