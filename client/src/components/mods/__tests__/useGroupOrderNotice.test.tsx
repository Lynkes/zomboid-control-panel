import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGroupOrderNotice } from '../useGroupOrderNotice'
import { modsApi } from '@/lib/api'

// POST /mods/save-order reports conflicting mod groups by id (a UUID); the
// toast listed those ids, which mean nothing to the admin.

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, modsApi: { ...actual.modsApi, getGroups: vi.fn() } }
})

const getGroups = vi.mocked(modsApi.getGroups)
const VEHICLES = '6f1c2a9e-0b7d-4c1e-9a55-2f0d8c7b1e01'
const MAPS = '0a9d3b2c-7e6f-4d5a-8b1c-3e2f1a0b9c8d'
const GONE = 'deadbeef-0000-4000-8000-000000000000'

function group(id: string, name: string) {
  return { id, name, description: '', modIds: [], createdAt: '', updatedAt: '' }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useGroupOrderNotice', () => {
  it('names conflicting groups by their names, falling back to the id for one it cannot find', async () => {
    getGroups.mockResolvedValue({ groups: [group(VEHICLES, 'Vehicle pack'), group(MAPS, 'Maps')], enforce: true })
    const { result } = renderHook(() => useGroupOrderNotice())

    await result.current({ groupConflicts: [VEHICLES, MAPS, GONE] })

    expect(toast).toHaveBeenCalledTimes(1)
    const description = String(toast.mock.calls[0][0].description)
    expect(description).toContain('Vehicle pack, Maps')
    expect(description).toContain(GONE)
    expect(description).not.toContain(VEHICLES)
  })

  it('uses the names when the order was also adjusted', async () => {
    getGroups.mockResolvedValue({ groups: [group(VEHICLES, 'Vehicle pack')], enforce: true })
    const { result } = renderHook(() => useGroupOrderNotice())

    await result.current({ groupsAdjusted: ['ModA'], groupConflicts: [VEHICLES] })

    const description = String(toast.mock.calls[0][0].description)
    expect(description).toContain('Vehicle pack')
    expect(description).not.toContain(VEHICLES)
  })

  it('still warns, with the ids, when the group list cannot be loaded', async () => {
    getGroups.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useGroupOrderNotice())

    await result.current({ groupConflicts: [VEHICLES] })

    expect(String(toast.mock.calls[0][0].description)).toContain(VEHICLES)
  })

  it('does not look anything up when the order went through as sent', async () => {
    const { result } = renderHook(() => useGroupOrderNotice())

    await result.current({ groupsAdjusted: [], groupConflicts: [] })

    expect(getGroups).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})
