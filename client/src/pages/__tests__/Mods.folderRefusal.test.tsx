import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import enMods from '../../locales/en/mods.json'
import enErrors from '../../locales/en/errors.json'

// PT3 (security sweep 2026-10-05, verifier round 1): the Mods page shows
// the folder refusal from GET /mods/current-config instead of "config not
// found / start the server". A stored data folder refused where it is used
// has its own code (ZOMBOID_DATA_FOLDER_REFUSED), whose text says where to
// set the folder; with the save-time code the page showed the save-time
// text, which didn't.

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

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ connected: true, on: () => {}, off: () => {}, emit: vi.fn() }),
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
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

Element.prototype.scrollIntoView = vi.fn()

function prime(config: Record<string, unknown>) {
  vi.mocked(modsApi.getTrackedMods).mockResolvedValue({ mods: [] } as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ totalModsTracked: 0, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  vi.mocked(modsApi.getCurrentConfig).mockResolvedValue(config as never)
  vi.mocked(modsApi.getIgnoredMods).mockResolvedValue([] as never)
  vi.mocked(modsApi.getIgnoredModPairs).mockResolvedValue([] as never)
  vi.mocked(modsApi.collectionDiff).mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  vi.mocked(modsApi.getPresets).mockResolvedValue([] as never)
  vi.mocked(modsApi.getCachedConflicts).mockResolvedValue(null as never)
  vi.mocked(modsApi.listDiskOnly).mockResolvedValue({ mods: [] } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Mods page: folder refusal', () => {
  it('shows the translated data-folder refusal, which names the page to fix it on, and not the "start the server" hint', async () => {
    prime({
      configured: false,
      error: 'raw server text',
      code: 'ZOMBOID_DATA_FOLDER_REFUSED',
      modIds: [],
      workshopIds: [],
      totalMods: 0,
    })
    renderMods()
    await waitFor(() => expect(modsApi.getCurrentConfig).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(enMods.nav.active.label, 'i') }))
    const shown = await screen.findByText(enErrors.ZOMBOID_DATA_FOLDER_REFUSED)
    expect(shown.textContent).toContain('My Servers page')
    expect(shown.textContent).toContain('a world save in its Saves folder')
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument()
    expect(screen.queryByText(enMods.serverConfigTab.notConfiguredHint)).not.toBeInTheDocument()
  })

  it('a config folder with no data folder shows SERVER_CONFIG_PATH_OUTSIDE_DATA', async () => {
    prime({ configured: false, error: 'x', code: 'SERVER_CONFIG_PATH_OUTSIDE_DATA', modIds: [], workshopIds: [], totalMods: 0 })
    renderMods()
    await waitFor(() => expect(modsApi.getCurrentConfig).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(enMods.nav.active.label, 'i') }))
    expect(await screen.findByText(enErrors.SERVER_CONFIG_PATH_OUTSIDE_DATA)).toBeInTheDocument()
  })

  it('a plain "not set" keeps the old hint', async () => {
    prime({ configured: false, error: 'Server config path not set', code: 'MODS_CONFIG_PATH_NOT_SET', modIds: [], workshopIds: [], totalMods: 0 })
    renderMods()
    await waitFor(() => expect(modsApi.getCurrentConfig).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(enMods.nav.active.label, 'i') }))
    expect(await screen.findByText(enMods.serverConfigTab.notConfiguredHint)).toBeInTheDocument()
  })
})
