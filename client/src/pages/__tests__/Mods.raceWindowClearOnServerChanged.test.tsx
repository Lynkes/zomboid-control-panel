import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// pz-bughunt round 17b (approved design call, closing the "race-window"
// class flagged in the round-17 report): toggleModId, batchToggleModIds,
// deleteDiskMod, batchDeleteDiskMods, batchRemove, removeFromIni,
// enableDiskMod all read their target workshop/mod id from a row rendered
// out of mods/disabledMods/ignoredMods -- state fetched for whichever
// server was active at that time. activeServerChanged used to only trigger
// a plain refetch (fetchData()), leaving the OLD server's rows fully
// visible and clickable for however long that refetch takes -- a click in
// that window sent the OLD server's id as a write against the NEW active
// server. Fixed by clearing mods/disabledMods/ignoredMods outright the
// instant the switch happens, mirroring WorldMap.tsx's own selection-state
// clear -- nothing stale survives to be clicked, so no per-handler guard is
// needed. This test targets the "Show disabled" panel (disabledMods, a
// plain non-virtualized list, unlike the Installed tab's virtualized one)
// since it's the simplest, most direct place to observe the clear.

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
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
      deleteDiskMod: vi.fn(),
    },
  }
})

// STABLE module-level fake socket -- a fresh object literal per useSocket()
// call thrashes any effect depending on [socket, ...].
const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const deleteDiskMod = vi.mocked(modsApi.deleteDiskMod)

function primeReadMocks() {
  // The "Show disabled" toggle only renders when the Installed tab has at
  // least one tracked mod (see Mods.tsx's own `{mods.length > 0 && (...)}`
  // guard around the search/filter toolbar) -- seed one so the toolbar
  // (and the toggle this test needs) actually renders.
  getTrackedMods.mockResolvedValue({
    mods: [{ workshop_id: '1', name: 'Tracked Mod', last_checked: '2026-01-01' }],
  } as never)
  getStatus.mockResolvedValue({ totalModsTracked: 0, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: [],
    workshopIds: [],
    maps: [],
    totalMods: 0,
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(null as never)
  // Never resolves on its own during this test -- proves the row disappears
  // from a synchronous state clear, not because a refetch already replaced
  // it with an empty list.
  listDiskOnly.mockReturnValue(new Promise(() => {}))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
}

describe('Mods.tsx: activeServerChanged clears the disabled-mods list before any refetch lands', () => {
  it('removes a previously-listed disk-only mod row (and its delete action) the instant the server changes', async () => {
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    // Open "Show disabled" and let it populate from a real, resolved fetch.
    listDiskOnly.mockResolvedValueOnce({ mods: [{ workshop_id: '555', name: 'Orphan Mod' }] } as never)
    fireEvent.click(await screen.findByRole('button', { name: /show disabled/i }))
    await screen.findByText('Orphan Mod')

    // From here on, listDiskOnly hangs forever (see primeReadMocks) -- any
    // reappearance of the row could only come from stale state surviving,
    // never from a fresh, resolved refetch.
    emitActiveServerChanged()

    await waitFor(() => expect(screen.queryByText('Orphan Mod')).not.toBeInTheDocument())

    // With the row gone, its delete button is gone too -- nothing left to
    // click that could still fire deleteDiskMod('555') against whichever
    // server is active now.
    expect(deleteDiskMod).not.toHaveBeenCalled()
  })
})
