import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// Discover in the Add-mod dialog can run SteamCMD for minutes (it downloads
// an item the server doesn't have yet). Closing the dialog never aborted the
// request, so the download went on, the dialog stayed "discovering" (a
// reopened dialog ignored a new URL), and the old result filled the reopened
// dialog when it finally arrived.

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
    },
  }
})

const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: () => {},
  off: () => {},
  emit: () => {},
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))

const discoverModIds = vi.mocked(modsApi.discoverModIds)

function primeReadMocks() {
  vi.mocked(modsApi.getTrackedMods).mockResolvedValue({ mods: [] } as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ totalModsTracked: 0, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  vi.mocked(modsApi.getCurrentConfig).mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as never)
  vi.mocked(modsApi.getIgnoredMods).mockResolvedValue([] as never)
  vi.mocked(modsApi.getIgnoredModPairs).mockResolvedValue([] as never)
  vi.mocked(modsApi.collectionDiff).mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  vi.mocked(modsApi.getPresets).mockResolvedValue([] as never)
  vi.mocked(modsApi.getCachedConflicts).mockResolvedValue(null as never)
  vi.mocked(modsApi.listDiskOnly).mockResolvedValue({ mods: [] } as never)
}

const discovered = (workshopId: string, name: string) => ({
  workshopId,
  name,
  description: null,
  modIds: [`${name.replace(/\s/g, '')}Id`],
  isMap: false,
  mapFolders: [],
  isDownloaded: true,
  tags: [],
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function discoverIn(dialog: HTMLElement, workshopId: string) {
  fireEvent.change(within(dialog).getByPlaceholderText(/paste workshop url or enter id/i), { target: { value: workshopId } })
  fireEvent.click(within(dialog).getByRole('button', { name: /^discover$/i }))
}

describe('Mods.tsx: closing the Add-mod dialog stops its discovery', () => {
  it.each([
    ['Cancel', (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))],
    ['Escape', (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: 'Escape' })],
  ])('aborts the request on %s, takes a new URL when reopened, and never shows the old result', async (_how, close) => {
    primeReadMocks()
    // The first lookup is still running (SteamCMD downloading) and answers
    // late, after the dialog was closed -- the request layer does not always
    // turn an abort into a rejection in time.
    let resolveFirst: (value: unknown) => void = () => {}
    const signals: AbortSignal[] = []
    discoverModIds
      .mockImplementationOnce((_id, _url, options) => {
        signals.push(options!.signal!)
        return new Promise((resolve) => { resolveFirst = resolve }) as never
      })
      .mockImplementationOnce(async (_id, _url, options) => {
        signals.push(options!.signal!)
        return discovered('222222222', 'New Mod') as never
      })

    render(
      <MemoryRouter>
        <TooltipProvider>
          <Mods />
        </TooltipProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(modsApi.getTrackedMods).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
    let dialog = await screen.findByRole('dialog')
    await discoverIn(dialog, '111111111')
    await waitFor(() => expect(discoverModIds).toHaveBeenCalledTimes(1))
    expect(signals[0].aborted).toBe(false)

    close(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The request is gone, so the server stops its SteamCMD download.
    expect(signals[0].aborted).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Add Mod' }))
    dialog = await screen.findByRole('dialog')
    await discoverIn(dialog, '222222222')
    await waitFor(() => expect(discoverModIds).toHaveBeenCalledTimes(2))
    expect(discoverModIds).toHaveBeenLastCalledWith('222222222', undefined, expect.anything())
    await within(dialog).findByText('New Mod')

    // The old answer finally arrives: it belongs to a closed dialog.
    await act(async () => {
      resolveFirst(discovered('111111111', 'Old Mod'))
      await Promise.resolve()
    })
    expect(within(dialog).queryByText('Old Mod')).not.toBeInTheDocument()
    expect(within(dialog).getByText('New Mod')).toBeInTheDocument()
  })
})
