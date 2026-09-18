import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'
import type { ConflictScanResult } from '@/types'

// pz-bughunt round 18 (the narrower server-switch races flagged in round
// 17): depSearchOpen/depSearchData/depAdding/depAddResults are lifted state
// in Mods.tsx, shared with ConflictsPanel.tsx's own dependency-search UI
// (handleAddDep there, handleInspectorAddDep in Mods.tsx itself) -- both
// call modsApi.addMissingDep(hit.workshopId, ...) with a Steam search hit
// looked up in the context of a specific mod's missing dependency for
// whichever server was active at search time. If the active server changes
// while a search panel is still open with candidate results showing, none
// of that was guarded -- clicking a stale candidate's "Add" button would
// still write it into the new server's real ini. Fixed by clearing all
// four pieces of state on activeServerChanged, closing the window for both
// surfaces at once.

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
      searchWorkshopMods: vi.fn(),
      addMissingDep: vi.fn(),
    },
  }
})

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
const searchWorkshopMods = vi.mocked(modsApi.searchWorkshopMods)
const addMissingDep = vi.mocked(modsApi.addMissingDep)

const conflictResult: ConflictScanResult = {
  totalConflicts: 0,
  identicalSkipped: 0,
  pairs: [],
  totalPairs: 0,
  modsScanned: 1,
  missingDeps: [
    {
      modId: 'ParentMod',
      modName: 'Parent Mod',
      workshopId: 'ws-parent',
      missingDep: 'MissingDepId',
    },
  ],
  steamDeps: [],
  modLoadOrder: [],
}

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
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
  getCachedConflicts.mockResolvedValue(conflictResult as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
}

beforeEach(() => {
  localStorage.clear()
})

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

describe('Mods.tsx: activeServerChanged clears an open dependency-search panel before the refetch lands', () => {
  it('removes a found candidate\'s Add button and never calls addMissingDep for it', async () => {
    primeReadMocks()
    searchWorkshopMods.mockResolvedValue({
      results: [{ workshopId: 'ws-candidate', modName: 'Candidate Mod', modId: 'CandidateModId', isDownloaded: false }],
      searchUrl: null,
      variantsTried: [],
      steamSearchEnabled: true,
    } as never)

    renderMods()
    await waitForLoaded()

    fireEvent.click(await screen.findByRole('button', { name: /^conflicts/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^missing dependencies/i }))

    fireEvent.click(await screen.findByRole('button', { name: /search workshop/i }))
    await waitFor(() => expect(searchWorkshopMods).toHaveBeenCalledTimes(1))
    const addButton = await screen.findByRole('button', { name: /^add$/i })
    expect(addButton).toBeInTheDocument()

    emitActiveServerChanged()

    await waitFor(() => expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument())
    expect(addMissingDep).not.toHaveBeenCalled()
  })
})
