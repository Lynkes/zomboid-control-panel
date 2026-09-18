import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import en from '@/locales/en/players.json'

// Players-UX-sense-check 2026-09-18: the Spawn tab's three cards (Give
// Items, Spawn Vehicle, Give XP) all render a different description
// depending on whether a player is selected. Give Items and Spawn Vehicle
// both tell the operator what to do about the no-selection state ("Pick a
// player first...", "select a player to spawn vehicles near them instead").
// Give XP's no-player copy used to just restate the feature ("Grant
// experience to the selected player") as if a player WERE already picked --
// self-contradictory given none is, and the one card of the three that never
// told the operator what to do next (irritant 2). Fixed to match its
// siblings' "pick a player first" pattern.

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

async function setUpFixtures() {
  // No players online at all -- the Spawn tab (and its Give XP card) is
  // reachable, and its no-player copy is what's on screen, regardless of
  // roster state.
  getPlayers.mockResolvedValue({ players: [] })
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: Spawn tab "Give XP" no-player copy matches its sibling cards', () => {
  it('tells the operator to pick a player first, the same way Give Items already does, instead of describing the feature as if one were already selected', async () => {
    await setUpFixtures()
    renderPlayers()

    // Tabs render regardless of whether a player is selected (defaultValue
    // is "moderation"); switch to Spawn the same way the existing Powers-tab
    // tests do -- Radix's TabsTrigger switches on mousedown, not click.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Spawn' })).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })

    // "Give XP" appears twice once the tab is open (the card heading and the
    // submit button) -- wait on the description text itself, which is unique.
    await waitFor(() => expect(screen.getByText(en.spawn.giveXpDescNoPlayer)).toBeInTheDocument())

    expect(screen.getAllByText(en.spawn.giveXpTitle).length).toBeGreaterThan(0)
    expect(screen.queryByText('Grant experience to the selected player')).not.toBeInTheDocument()
  })
})
