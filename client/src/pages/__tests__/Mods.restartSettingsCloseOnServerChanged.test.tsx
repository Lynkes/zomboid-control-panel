import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// pz-bughunt round 18 (the narrower server-switch races flagged in round
// 17): restartWarningMinutes/delayIfPlayersOnline/maxDelayMinutes are
// populated from THIS server's status at fetch time, and
// handleSaveRestartSettings writes them via modsApi.setRestartOptions(),
// which resolves "the active server" server-side with no id sent. If the
// small Auto-Restart Settings dialog stays open across a switch, saving
// would write the OLD server's edited values into the NEW one. Fixed by
// closing the dialog outright on activeServerChanged, the same shape
// Backups.tsx's own handler already uses for its restore/delete dialogs.

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
      setRestartOptions: vi.fn(),
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
const setRestartOptions = vi.mocked(modsApi.setRestartOptions)

function primeReadMocks() {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  // The "More actions" dropdown (and the whole status bar it lives in) only
  // renders when mods are tracked -- see Mods.tsx's own
  // `{(status?.totalModsTracked || 0) > 0 && (...)}` guard.
  getStatus.mockResolvedValue({
    totalModsTracked: 1, workshopAcfConfigured: false, autoRestartEnabled: true,
    restartWarningMinutes: 5, delayIfPlayersOnline: false, maxDelayMinutes: 30,
  } as never)
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

async function openMoreActionsMenu() {
  // Radix's DropdownMenuTrigger opens on pointerdown, not click.
  const trigger = await screen.findByRole('button', { name: /more actions/i })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

describe('Mods.tsx: activeServerChanged closes the Auto-Restart Settings dialog before it can be saved to the wrong server', () => {
  it('closes the dialog and never calls setRestartOptions after the active server changed', async () => {
    primeReadMocks()
    renderMods()
    await waitForLoaded()

    const menu = await openMoreActionsMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /auto-restart settings/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Auto-Restart Settings')).toBeInTheDocument()

    emitActiveServerChanged()

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(setRestartOptions).not.toHaveBeenCalled()
  })
})
