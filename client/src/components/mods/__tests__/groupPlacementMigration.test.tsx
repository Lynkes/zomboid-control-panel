import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { modsApi, type ModGroup } from '@/lib/api'
import { LEGACY_PLACEMENT_KEY, migrateLegacyPlacements } from '../groupPlacementMigration'
import { useModGroupsStore } from '../useModGroupsStore'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: { ...actual.modsApi, getGroups: vi.fn(), getGroupsStatus: vi.fn(), updateGroup: vi.fn() },
  }
})

const group = (id: string, placement: ModGroup['placement'] = null): ModGroup => ({
  id,
  name: id,
  description: '',
  modIds: ['a', 'b'],
  createdAt: '',
  updatedAt: '',
  placement,
})

afterEach(() => {
  localStorage.clear()
  vi.mocked(modsApi.getGroups).mockReset()
  vi.mocked(modsApi.getGroupsStatus).mockReset()
  vi.mocked(modsApi.updateGroup).mockReset()
})

describe('migrateLegacyPlacements', () => {
  it('PUTs each browser placement the server lacks, then removes the key', async () => {
    localStorage.setItem(LEGACY_PLACEMENT_KEY, JSON.stringify({ g1: 'first', g2: 'last', g3: 'last', gone: 'first' }))
    const update = vi.fn().mockResolvedValue({})
    const result = await migrateLegacyPlacements([group('g1'), group('g2', 'first'), group('g3')], update)
    // g2 already has a placement on the server: the server's value stays.
    expect(update.mock.calls).toEqual([['g1', { placement: 'first' }], ['g3', { placement: 'last' }]])
    expect(result).toEqual({ migrated: ['g1', 'g3'], done: true })
    expect(localStorage.getItem(LEGACY_PLACEMENT_KEY)).toBeNull()
  })

  it('keeps the key when a PUT fails, so the next load tries again', async () => {
    localStorage.setItem(LEGACY_PLACEMENT_KEY, JSON.stringify({ g1: 'first', g2: 'last' }))
    const update = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline'))
    const result = await migrateLegacyPlacements([group('g1'), group('g2')], update)
    expect(result).toEqual({ migrated: ['g1'], done: false })
    expect(localStorage.getItem(LEGACY_PLACEMENT_KEY)).not.toBeNull()
  })

  it('does nothing without a stored key', async () => {
    const update = vi.fn()
    expect(await migrateLegacyPlacements([group('g1')], update)).toEqual({ migrated: [], done: true })
    expect(update).not.toHaveBeenCalled()
  })
})

describe('useModGroupsStore placements', () => {
  it('reads placements from the server and migrates the browser ones once on load', async () => {
    localStorage.setItem(LEGACY_PLACEMENT_KEY, JSON.stringify({ g1: 'last' }))
    vi.mocked(modsApi.getGroups)
      .mockResolvedValueOnce({ groups: [group('g1'), group('g2', 'first')], enforce: false })
      .mockResolvedValue({ groups: [group('g1', 'last'), group('g2', 'first')], enforce: false })
    vi.mocked(modsApi.getGroupsStatus).mockResolvedValue({ groups: [], inOrder: true, conflicts: [] } as never)
    vi.mocked(modsApi.updateGroup).mockResolvedValue({ group: group('g1', 'last') })

    const { result } = renderHook(() => useModGroupsStore())
    await waitFor(() => expect(result.current.placements).toEqual({ g1: 'last', g2: 'first' }))
    expect(modsApi.updateGroup).toHaveBeenCalledTimes(1)
    expect(modsApi.updateGroup).toHaveBeenCalledWith('g1', { placement: 'last' })
    expect(localStorage.getItem(LEGACY_PLACEMENT_KEY)).toBeNull()
  })
})
