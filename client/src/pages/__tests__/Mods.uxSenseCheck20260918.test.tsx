import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// Mods-UX-sense-check 2026-09-18 (operator ask: does this page make sense to
// a first-time operator). Three findings covered here:
//
// 1. Confirm dialogs must name the specific target. The single-mod "Remove"
//    confirm dialog (used by the Installed tab, the "removed from Workshop"
//    banner, the Active-config kebab menu, and the Deactivated tab) used to
//    say only "Remove this mod from the server?" no matter which mod was
//    clicked -- indistinguishable once more than one row is in play.
//    removeModDialog.title now takes {{name}}.
//
// 2. Disabled controls must say why. The header "Sync" / "Check Updates"
//    buttons and the empty-state's "Sync from server" tile were plain
//    disabled Buttons with no DisabledReason wrapper -- and a disabled
//    Button carries `disabled:pointer-events-none`, so a Tooltip attached
//    directly to it never opens on hover. A mods.manage-less operator saw a
//    greyed-out button and got no explanation at all.

let mockCanManageMods = true
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (cap: string) => (cap === 'mods.manage' ? mockCanManageMods : true),
  }),
}))

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
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
      batchRemove: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
    },
  }
})

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Mods />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const BASE_STATUS = {
  totalModsTracked: 1,
  totalModsInWorkshop: 1,
  updatesAvailable: 0,
  lastCheck: null,
  lastUpdateDetected: null,
  autoRestartEnabled: false,
  running: true,
  workshopAcfConfigured: true,
  workshopAcfPath: 'C:\\server\\steamapps\\workshop',
  checkInterval: 1800000,
  modsNeedingUpdate: [],
  restartWarningMinutes: 5,
  delayIfPlayersOnline: false,
  maxDelayMinutes: 30,
  pendingRestart: false,
  steamApiHealthy: true,
  lastSteamApiFailureAt: null,
  removedWorkshopIds: [] as string[],
  unknownWorkshopIds: [] as Array<{ id: string; resultCode: number }>,
}

function primeReadMocks(statusOverrides: Partial<typeof BASE_STATUS> = {}, trackedMods: any[] = []) {
  getTrackedMods.mockResolvedValue({ mods: trackedMods } as any)
  getStatus.mockResolvedValue({ ...BASE_STATUS, ...statusOverrides } as any)
  getCurrentConfig.mockResolvedValue({
    configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0,
  } as any)
  getIgnoredMods.mockResolvedValue([] as any)
  getIgnoredModPairs.mockResolvedValue([] as any)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
  getPresets.mockResolvedValue([] as any)
  getCachedConflicts.mockResolvedValue(null as any)
  listDiskOnly.mockResolvedValue({ mods: [] } as any)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  toastSpy.mockClear()
  mockCanManageMods = true
})

describe('Mods.tsx UX sense check: single-mod remove dialog names the target', () => {
  it('shows the actual mod name in the confirm dialog heading, not a generic "this mod"', async () => {
    primeReadMocks(
      { removedWorkshopIds: ['123456789'] },
      [{
        id: 1, workshop_id: '123456789', name: 'Definitely Gone Mod',
        last_updated: '', last_checked: null, update_available: 0, created_at: '',
      }],
    )
    renderMods()

    fireEvent.click(await screen.findByRole('button', { name: /remove definitely gone mod from the server/i }))

    expect(await screen.findByText(/Remove Definitely Gone Mod from the server\?/i)).toBeInTheDocument()
    expect(screen.queryByText('Remove this mod from the server?')).not.toBeInTheDocument()
  })
})

describe('Mods.tsx UX sense check: disabled Sync/Check Updates buttons explain why', () => {
  it('shows the permission reason on hover once mods.manage is missing (header status bar)', async () => {
    mockCanManageMods = false
    primeReadMocks({ totalModsTracked: 1 }, [{
      id: 1, workshop_id: '1', name: 'Some Mod',
      last_updated: '', last_checked: null, update_available: 0, created_at: '',
    }])
    renderMods()

    const syncButton = await screen.findByRole('button', { name: /^sync$/i })
    expect(syncButton).toBeDisabled()

    // DisabledReason's actual Tooltip trigger is the focusable wrapper span
    // around the (inert, disabled) button -- see DisabledReason.tsx. A
    // Tooltip attached directly to a disabled Button never opens (disabled:
    // pointer-events-none), which is exactly the bug this covers.
    const wrapper = syncButton.parentElement
    expect(wrapper).not.toBeNull()
    fireEvent.focus(wrapper!)

    expect(await screen.findByText('Your role does not have permission to manage mods.')).toBeInTheDocument()
  })

  it('does not show a permission reason when the operator can manage mods', async () => {
    mockCanManageMods = true
    primeReadMocks({ totalModsTracked: 1 }, [{
      id: 1, workshop_id: '1', name: 'Some Mod',
      last_updated: '', last_checked: null, update_available: 0, created_at: '',
    }])
    renderMods()

    const syncButton = await screen.findByRole('button', { name: /^sync$/i })
    await waitFor(() => expect(syncButton).not.toBeDisabled())
  })
})

describe('Mods.tsx UX sense check: empty-state "Sync from server" tile explains why it is disabled', () => {
  it('shows the permission reason on hover when the list is empty and mods.manage is missing', async () => {
    mockCanManageMods = false
    primeReadMocks({ totalModsTracked: 0 }, [])
    renderMods()

    const syncTile = await screen.findByRole('button', { name: /sync from server/i })
    expect(syncTile).toBeDisabled()

    const wrapper = syncTile.parentElement
    expect(wrapper).not.toBeNull()
    fireEvent.focus(wrapper!)

    expect(await screen.findByText('Your role does not have permission to manage mods.')).toBeInTheDocument()
  })
})
