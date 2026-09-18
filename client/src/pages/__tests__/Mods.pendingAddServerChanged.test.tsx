import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// pz-bughunt round 17 (every write that trusts the server-side active
// server): modsApi.addModAdvanced() -- reached both from the Add-mod-by-
// workshop-ID dialog (handleAddModAdvanced) and from the Import Collection
// dialog (handleAddCollectionMods) -- resolves the active server server-side
// with no server id sent. Its payload (discovered mod IDs / map folders) was
// looked up via modsApi.discoverModIds()/importCollection(), which
// themselves resolve auto-detection against whichever server was active at
// DISCOVERY time (see routes/mods.js's findModIdFromWorkshop, which reads
// the active server's own on-disk workshop mount). If the active server
// changes while either dialog is still open, the ids/map-folders shown were
// resolved for the OLD server and may not even apply to the NEW one --
// clicking Add would still silently write them into the new server's real
// ini. Guarded by pendingAddServerChanged, mirroring serverChangedSinceLoad
// (see Mods.activeServerChanged.test.tsx) for the reorder hazard.

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
      discoverModIds: vi.fn(),
      trackMod: vi.fn(),
      addModAdvanced: vi.fn(),
      importCollection: vi.fn(),
    },
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
const discoverModIds = vi.mocked(modsApi.discoverModIds)
const trackMod = vi.mocked(modsApi.trackMod)
const addModAdvanced = vi.mocked(modsApi.addModAdvanced)
const importCollection = vi.mocked(modsApi.importCollection)

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
  getCachedConflicts.mockResolvedValue(null as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
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

describe('Mods.tsx: activeServerChanged blocks writes from a still-open add-mod dialog', () => {
  it('handleAddModAdvanced: disables Add and never calls addModAdvanced once the server changed mid-discovery', async () => {
    primeReadMocks()
    discoverModIds.mockResolvedValue({
      workshopId: '123456789',
      name: 'Test Mod',
      description: null,
      modIds: ['TestModId'],
      isMap: false,
      mapFolders: [],
      isDownloaded: true,
      tags: [],
    } as never)
    trackMod.mockResolvedValue({} as never)
    addModAdvanced.mockResolvedValue({ addedModIds: ['TestModId'], mapFoldersAdded: [], workshopAlreadyExisted: false } as never)

    renderMods()
    await waitForLoaded()

    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
    const dialog = await screen.findByRole('dialog')

    const input = within(dialog).getByPlaceholderText(/paste workshop url or enter id/i)
    fireEvent.change(input, { target: { value: '123456789' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^discover$/i }))

    await waitFor(() => expect(discoverModIds).toHaveBeenCalledTimes(1))
    await within(dialog).findByText('Test Mod')

    const addButton = within(dialog).getByRole('button', { name: /^add /i })
    expect(addButton).not.toBeDisabled()

    // The active server changes elsewhere while the discovered-mod card is
    // still showing -- the ids/map folders on screen were resolved for the
    // PREVIOUS server's own workshop mount.
    emitActiveServerChanged()

    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^add /i })).toBeDisabled())

    fireEvent.click(within(dialog).getByRole('button', { name: /^add /i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(addModAdvanced).not.toHaveBeenCalled()
  })

  it('handleAddCollectionMods: disables the add-to-server action and never calls addModAdvanced once the server changed mid-review', async () => {
    primeReadMocks()
    importCollection.mockResolvedValue({
      mods: [
        { workshopId: '111', name: 'Collection Mod One', isMap: false },
      ],
    } as never)
    addModAdvanced.mockResolvedValue({ addedModIds: ['a'], mapFoldersAdded: [], workshopAlreadyExisted: false } as never)

    renderMods()
    await waitForLoaded()

    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
    const addDialog = await screen.findByRole('dialog')
    fireEvent.click(within(addDialog).getByRole('button', { name: /import an entire collection/i }))

    const collectionDialog = await screen.findByRole('dialog')
    // Exact match, not a substring regex -- the adjacent HelpTip button's
    // own aria-label ("Help: Collection URL or ID") also CONTAINS this
    // text, so a case-insensitive substring match finds both.
    const urlInput = within(collectionDialog).getByLabelText('Collection URL or ID')
    fireEvent.change(urlInput, { target: { value: '987654321' } })

    // The fetch/import button carries no accessible name (icon-only) --
    // it's the only button left in the dialog besides Cancel/close.
    const importButton = within(collectionDialog)
      .getAllByRole('button')
      .find((b) => b.querySelector('svg.lucide-download'))
    expect(importButton).not.toBeUndefined()
    fireEvent.click(importButton!)

    await waitFor(() => expect(importCollection).toHaveBeenCalledTimes(1))
    await within(collectionDialog).findByText('Collection Mod One')

    const addToServerButton = within(collectionDialog).getByRole('button', { name: /add.*mod/i })
    expect(addToServerButton).not.toBeDisabled()

    emitActiveServerChanged()

    await waitFor(() => expect(within(collectionDialog).getByRole('button', { name: /add.*mod/i })).toBeDisabled())

    fireEvent.click(within(collectionDialog).getByRole('button', { name: /add.*mod/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(addModAdvanced).not.toHaveBeenCalled()
  })
})
