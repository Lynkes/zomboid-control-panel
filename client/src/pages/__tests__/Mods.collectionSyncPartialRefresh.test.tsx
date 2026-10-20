import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { ApiError, modsApi } from '@/lib/api'

// Sync on the Mods page's collection chip: a partial sync (Steam took some
// items, then refused one) comes back as an error, and the chip was only
// refreshed on success, so it kept the old "N drift" count although part of
// it was synced.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      collectionSync: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
    },
  }
})

const fakeSocket = vi.hoisted(() => ({ connected: true, on: () => {}, off: () => {}, emit: () => {} }))
vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => fakeSocket }))

const collectionDiff = vi.mocked(modsApi.collectionDiff)

function diffWith(toAdd: string[]) {
  return { ok: true, collectionId: '9999999999', title: 'Server mods', toAdd, toRemove: [], autoSync: false, items: [] } as never
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Mods.tsx: collection chip after Sync', () => {
  it('refreshes the drift count after a partial sync, not only after a full one', async () => {
    vi.mocked(modsApi.getTrackedMods).mockResolvedValue({ mods: [{ workshop_id: '1111111111', name: 'Tracked Mod', last_checked: '2026-01-01' }] } as never)
    vi.mocked(modsApi.getStatus).mockResolvedValue({ totalModsTracked: 0, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
    vi.mocked(modsApi.getCurrentConfig).mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as never)
    vi.mocked(modsApi.getIgnoredMods).mockResolvedValue([] as never)
    vi.mocked(modsApi.getIgnoredModPairs).mockResolvedValue([] as never)
    vi.mocked(modsApi.getPresets).mockResolvedValue([] as never)
    vi.mocked(modsApi.getCachedConflicts).mockResolvedValue(null as never)
    vi.mocked(modsApi.listDiskOnly).mockResolvedValue({ mods: [] } as never)
    collectionDiff.mockResolvedValue(diffWith(['1111111111', '2222222222', '3333333333']))
    vi.mocked(modsApi.collectionSync).mockRejectedValue(
      new ApiError('Steam rejected 1 item', {
        status: 400,
        data: { success: false, added: ['1111111111', '2222222222'], errors: [{ action: 'add', id: '3333333333', error: 'x' }] },
      } as never),
    )

    render(
      <MemoryRouter>
        <TooltipProvider>
          <Mods />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await screen.findByText('3 drift')
    // What is left after the partial sync.
    collectionDiff.mockResolvedValue(diffWith(['3333333333']))
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))

    await waitFor(() => expect(modsApi.collectionSync).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('1 drift')).toBeInTheDocument()
  })
})
