import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// Players-UX-sense-check 2026-09-18: the dossier dropdown's "Remove from
// Whitelist" item is already correctly DISABLED once the whitelist fetch
// confirms the selected player isn't on it (selectedPlayerConfirmedNotWhitelisted,
// see isPlayerConfirmedNotWhitelisted's own test) -- but the DisabledReason
// wrapping it only ever passed permissions.noModerate as a reason, never one
// for THIS disable condition. An operator hovering a greyed-out item, right
// next to an enabled "Add to Whitelist" sibling, got no tooltip at all --
// irritant 2 ("disabled controls with no visible reason"), the same class of
// bug the bridgeRequiredTooltip and noModerate wiring already fixed
// elsewhere on this page. This test would have passed before the fix (no
// tooltip ever asserted) and fails now if the reason prop regresses back to
// null for this branch.

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
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getWhitelist: vi.fn(),
      getPerks: vi.fn(),
      getAccessLevels: vi.fn(),
      getSteamIdBans: vi.fn(),
      getNotes: vi.fn(),
      getStats: vi.fn(),
      getExports: vi.fn(),
      getActivityLogs: vi.fn(),
      removeFromWhitelist: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// TestPlayer is online but deliberately absent from the whitelist accounts
// fixture, so isPlayerConfirmedNotWhitelisted resolves true for it once the
// (successful, non-loading) getWhitelist fetch lands.
async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

// Radix's DropdownMenuTrigger opens on pointerdown, not click -- see
// Players.capabilityGating.test.tsx's openMoreActionsMenu, same precedent.
async function openMoreActionsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More player actions' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: "Remove from Whitelist" explains itself when disabled because the player is confirmed not whitelisted', () => {
  it('disables the item and names the player in a hover tooltip instead of leaving it silently greyed out', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await openMoreActionsMenu()

    const item = await screen.findByRole('menuitem', { name: 'Remove from Whitelist' })
    // Radix's DropdownMenuItem renders a <div role="menuitem">, not a native
    // disabled form control -- toBeDisabled() only applies to real
    // disableable elements, so the disabled state here is aria-disabled/
    // data-disabled instead.
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAttribute('data-disabled')

    // DisabledReason's actual Tooltip trigger is the focusable wrapper span
    // around the (inert, disabled) menu item -- see DisabledReason.tsx.
    const wrapper = item.parentElement
    expect(wrapper).not.toBeNull()
    fireEvent.focus(wrapper!)

    expect(await screen.findByText("TestPlayer isn't on the whitelist — nothing to remove.")).toBeInTheDocument()
  })

  it('shows no such reason, and enables the item, once the player IS confirmed on the whitelist', async () => {
    getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
    getWhitelist.mockResolvedValue({
      success: true,
      available: true,
      accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'user', authType: 0, steamId: null, ownerId: null, displayName: null }],
      allowedSteamIds: [],
    })
    getPerks.mockResolvedValue({ catalog: [] })
    getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
    getSteamIdBans.mockResolvedValue({ bans: [] })
    getNotes.mockResolvedValue({ notes: [] })
    getStats.mockResolvedValue({ stats: [] })
    getExports.mockResolvedValue({ exports: [] })
    getActivityLogs.mockResolvedValue({ logs: [] })
    getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
    getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
    getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)

    renderPlayers()
    await selectTestPlayer()
    await openMoreActionsMenu()

    const item = await screen.findByRole('menuitem', { name: 'Remove from Whitelist' })
    await waitFor(() => expect(item).not.toHaveAttribute('aria-disabled', 'true'))
  })
})
