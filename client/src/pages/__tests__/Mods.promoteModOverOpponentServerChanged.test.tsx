import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import type { ConflictScanResult } from '@/types'

// pz-bughunt round 16 (Mods page edge cases): Mods.activeServerChanged.test.tsx
// already locks in that handleSaveModOrder refuses to write a pending reorder
// into the WRONG server after an activeServerChanged switch
// (serverChangedSinceLoad, see Mods.tsx's own bug-hunt-2026-09-04/05
// comment). promoteModOverOpponent -- the inline "Make X win" button on each
// conflict pair card -- calls the exact same modsApi.saveModOrder(...) with
// no such guard: reorder mods (or just have a stale conflict scan whose
// modLoadOrder differs from the server's real config) on server A, switch
// the active server to B elsewhere while that reorder is unsaved, then click
// "Make X win" -- server A's stale order lands in server B's real INI with
// no warning at all. Same guard as handleSaveModOrder, same message.

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
      saveModOrder: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

// STABLE module-level fake socket -- a fresh object literal per useSocket()
// call thrashes any effect depending on [socket, ...] (see
// Mods.activeServerChanged.test.tsx's own comment for the full story).
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
const saveModOrder = vi.mocked(modsApi.saveModOrder)
const getActive = vi.mocked(serversApi.getActive)

const conflictResult: ConflictScanResult = {
  totalConflicts: 1,
  identicalSkipped: 0,
  pairs: [
    {
      modA: { workshopId: 'ws1', modId: 'modA', modName: 'Mod Alpha' },
      modB: { workshopId: 'ws2', modId: 'modB', modName: 'Mod Beta' },
      files: [{ file: 'media/lua/shared/Conflict.lua', category: 'lua', severity: 'high' }],
      highCount: 1,
      mediumCount: 0,
      lowCount: 0,
    },
  ],
  totalPairs: 1,
  modsScanned: 2,
  missingDeps: [],
  steamDeps: [],
  modLoadOrder: ['modA', 'modB'],
}

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  getStatus.mockResolvedValue({ totalModsTracked: 2, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ['modA', 'modB'],
    workshopIds: ['ws1', 'ws2'],
    maps: [],
    totalMods: 2,
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(conflictResult as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
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

describe('Mods.tsx: activeServerChanged also blocks the inline conflict "Make X win" promote action', () => {
  it('does not let "Make X win" write the previous server\'s stale order into the new active server', async () => {
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    // Create a pending, unsaved reorder the same way
    // Mods.activeServerChanged.test.tsx does for Save Order.
    fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
    const moveDownButtons = await screen.findAllByRole('button', { name: /move down/i })
    fireEvent.click(moveDownButtons[0])

    // Switch the active server elsewhere while that reorder is unsaved --
    // this is what flips serverChangedSinceLoad and (correctly) disables
    // Save Order.
    act(() => { emitActiveServerChanged() })
    await waitFor(() => expect(screen.getByRole('button', { name: /save order/i })).toBeDisabled())

    // Now go to the Conflicts tab and try the inline "Make X win" action --
    // a completely separate write path that must be guarded the same way.
    // The nav button's accessible name is its label immediately followed by
    // its hint text with no separating space ("ConflictsClashes and missing
    // dependencies"), so match on the label prefix only.
    fireEvent.click(await screen.findByRole('button', { name: /^conflicts/i }))
    // Two "Mod Alpha" labels render: the top-conflicting-mods filter chip
    // and the accordion trigger for the pair itself -- only the latter has
    // a data-state attribute (it's a radix AccordionTrigger button).
    const modAlphaLabels = await screen.findAllByText('Mod Alpha')
    const trigger = modAlphaLabels
      .map((el) => el.closest('button[data-state]'))
      .find((el): el is HTMLButtonElement => el != null)
    expect(trigger).not.toBeUndefined()
    fireEvent.click(trigger!)

    const makeAWin = await screen.findByRole('button', { name: /make a win/i })
    expect(makeAWin).not.toBeDisabled()
    fireEvent.click(makeAWin)

    // Give any (incorrect) async write a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saveModOrder).not.toHaveBeenCalled()
  })
})
