import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'
import { openModsView } from './modsNav'

// Importing a collection used to fire modsApi.addModAdvanced() once per mod
// (Promise.allSettled), and re-enabling deactivated mods called addToIni() in
// a loop. Every call is its own ini write on the server and so its own
// backup, and only the newest 10 backups are kept: a 60-mod import pushed the
// pre-import config out. Both now send ONE modsApi.addToIniBulk() request. The
// toast also stops promising "Restart the server to load the new mods" for
// mods that only reached WorkshopItems= (no mod ID known yet).

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

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
      addModAdvanced: vi.fn(),
      addToIni: vi.fn(),
      addToIniBulk: vi.fn(),
      importCollection: vi.fn(),
      discoverModIds: vi.fn(),
      trackMod: vi.fn(),
    },
  }
})

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
}))

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const addModAdvanced = vi.mocked(modsApi.addModAdvanced)
const addToIni = vi.mocked(modsApi.addToIni)
const addToIniBulk = vi.mocked(modsApi.addToIniBulk)
const importCollection = vi.mocked(modsApi.importCollection)
const discoverModIds = vi.mocked(modsApi.discoverModIds)
const trackMod = vi.mocked(modsApi.trackMod)

function primeReadMocks(tracked: Array<{ workshop_id: string; name: string }> = []) {
  getTrackedMods.mockResolvedValue({
    mods: tracked.map((m) => ({ ...m, last_checked: '2026-01-01' })),
  } as never)
  getStatus.mockResolvedValue({ totalModsTracked: tracked.length, workshopAcfConfigured: true, autoRestartEnabled: false } as never)
  getCurrentConfig.mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as never)
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

async function importCollectionOf(mods: Array<{ workshopId: string; name: string }>) {
  importCollection.mockResolvedValue({ mods: mods.map((m) => ({ ...m, isMap: false })) } as never)
  renderMods()
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())

  fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
  const addDialog = await screen.findByRole('dialog')
  fireEvent.click(within(addDialog).getByRole('button', { name: /import an entire collection/i }))
  const collectionDialog = await screen.findByRole('dialog')
  fireEvent.change(within(collectionDialog).getByLabelText('Collection URL or ID'), { target: { value: '987654321' } })
  const fetchButton = within(collectionDialog)
    .getAllByRole('button')
    .find((b) => b.querySelector('svg.lucide-download'))
  fireEvent.click(fetchButton!)
  await within(collectionDialog).findByText(mods[0].name)
  return collectionDialog
}

describe('Mods.tsx: Import Collection sends one bulk request', () => {
  it('adds every selected mod through addToIniBulk once, with tracking on, and never per mod', async () => {
    primeReadMocks()
    addToIniBulk.mockResolvedValue({
      success: true,
      total: 2,
      added: 2,
      alreadyConfigured: 0,
      workshopOnly: 0,
      invalid: 0,
      mapFoldersAdded: [],
      results: [
        { workshopId: '111', status: 'added', addedModIds: ['A'] },
        { workshopId: '222', status: 'added', addedModIds: ['B'] },
      ],
    } as never)
    const dialog = await importCollectionOf([
      { workshopId: '111', name: 'Collection Mod One' },
      { workshopId: '222', name: 'Collection Mod Two' },
    ])

    fireEvent.click(within(dialog).getByRole('button', { name: /add.*mod/i }))
    await waitFor(() => expect(addToIniBulk).toHaveBeenCalledTimes(1))

    expect(addToIniBulk).toHaveBeenCalledWith(
      [
        { workshopId: '111', selectedModIds: undefined, includeAllModIds: true },
        { workshopId: '222', selectedModIds: undefined, includeAllModIds: true },
      ],
      true,
    )
    expect(addModAdvanced).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '2 mods added to server config',
          description: 'Restart the server to load the new mods.',
          variant: 'success',
        }),
      ),
    )
  })

  it('does not promise a restart for mods that only reached WorkshopItems=, and says what to do', async () => {
    primeReadMocks()
    addToIniBulk.mockResolvedValue({
      success: true,
      total: 2,
      added: 0,
      alreadyConfigured: 0,
      workshopOnly: 2,
      invalid: 0,
      mapFoldersAdded: [],
      results: [
        { workshopId: '111', status: 'workshop-only', addedModIds: [] },
        { workshopId: '222', status: 'workshop-only', addedModIds: [] },
      ],
    } as never)
    const dialog = await importCollectionOf([
      { workshopId: '111', name: 'Collection Mod One' },
      { workshopId: '222', name: 'Collection Mod Two' },
    ])

    fireEvent.click(within(dialog).getByRole('button', { name: /add.*mod/i }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())

    const description = String(toastSpy.mock.calls.at(-1)?.[0]?.description)
    expect(description).not.toMatch(/restart the server to load/i)
    expect(description).toContain('2 of these have no mod ID yet')
    expect(description).toContain('WorkshopItems only')
    expect(description).toContain('Sync Mod IDs')
  })

  it('reports invalid items as failures', async () => {
    primeReadMocks()
    addToIniBulk.mockResolvedValue({
      success: true,
      total: 2,
      added: 1,
      alreadyConfigured: 0,
      workshopOnly: 0,
      invalid: 1,
      mapFoldersAdded: [],
      results: [
        { workshopId: '222', status: 'invalid', code: 'MODS_INVALID_WORKSHOP_ID_CAP' },
        { workshopId: '111', status: 'added', addedModIds: ['A'] },
      ],
    } as never)
    const dialog = await importCollectionOf([
      { workshopId: '111', name: 'Collection Mod One' },
      { workshopId: '222', name: 'Collection Mod Two' },
    ])

    fireEvent.click(within(dialog).getByRole('button', { name: /add.*mod/i }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '1 mod added to server config',
        description: '1 failed — check the console for details',
        variant: 'destructive',
      }),
    )
  })
})

describe('Mods.tsx: Re-enable on the Deactivated tab sends one bulk request', () => {
  it('re-enables the selected mods through addToIniBulk once instead of one addToIni each', async () => {
    primeReadMocks([
      { workshop_id: '111', name: 'Old Mod One' },
      { workshop_id: '222', name: 'Old Mod Two' },
    ])
    addToIniBulk.mockResolvedValue({
      success: true,
      total: 2,
      added: 1,
      alreadyConfigured: 0,
      workshopOnly: 1,
      invalid: 0,
      mapFoldersAdded: [],
      results: [
        { workshopId: '111', status: 'added', addedModIds: ['A'], alternativeModIds: ['A2'] },
        { workshopId: '222', status: 'workshop-only', addedModIds: [] },
      ],
    } as never)

    renderMods()
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
    await openModsView('Deactivated')
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all deactivated mods' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Re-enable (2)' }))

    await waitFor(() => expect(addToIniBulk).toHaveBeenCalledTimes(1))
    expect(addToIniBulk).toHaveBeenCalledWith([{ workshopId: '111' }, { workshopId: '222' }])
    expect(addToIni).not.toHaveBeenCalled()

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const toast = toastSpy.mock.calls.at(-1)?.[0]
    expect(toast.title).toBe('Mods Re-enabled')
    expect(toast.description).toContain('Added 2 mods back to the INI')
    expect(toast.description).toContain('A2') // the alternatives are still surfaced
    expect(toast.description).toContain('1 of these have no mod ID yet')
  })
})

describe('Mods.tsx: the Add Mod dialog tells a workshop-only add apart', () => {
  it('shows what to do instead of promising the mod ID will be discovered', async () => {
    primeReadMocks()
    discoverModIds.mockResolvedValue({
      workshopId: '123456789',
      name: 'Not Downloaded Yet',
      description: null,
      modIds: [],
      hasMultipleModIds: false,
      sources: [],
      isMap: false,
      mapFolders: [],
      isDownloaded: false,
      tags: [],
    } as never)
    trackMod.mockResolvedValue({} as never)
    addModAdvanced.mockResolvedValue({
      success: true,
      workshopId: '123456789',
      addedModIds: [],
      totalModIdsInConfig: 0,
      workshopAlreadyExisted: false,
      mapFoldersAdded: [],
      status: 'workshop-only',
      message: 'Workshop ID added to WorkshopItems only',
    } as never)

    renderMods()
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText(/paste workshop url or enter id/i), { target: { value: '123456789' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^discover$/i }))
    await within(dialog).findByText('Not Downloaded Yet')
    fireEvent.click(within(dialog).getByRole('button', { name: /^add /i }))

    await waitFor(() => expect(addModAdvanced).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const toast = toastSpy.mock.calls.at(-1)?.[0]
    expect(toast.title).toBe('Workshop ID Added')
    expect(toast.description).toContain('WorkshopItems only')
    expect(toast.description).toContain('Sync Mod IDs')
  })
})
