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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Since the 2026-10-20 restructure the player's tool tabs only render once a
// player is selected: before that the card is one "Select a player" prompt,
// not five tabs with nothing to act on. So the no-player state can't reach
// the Spawn tab any more; what's left to prove is that the prompt replaces
// the tabs, and that Give XP names the player once one is picked.
describe('Players.tsx: no player selected shows one prompt, not empty tool tabs', () => {
  it('shows "Select a player" and no tool tabs until a player is picked; then Give XP names them', async () => {
    await setUpFixtures()
    renderPlayers()

    await waitFor(() => expect(screen.getByText(en.dossier.noTargetTitle)).toBeInTheDocument())
    expect(screen.getByText(en.dossier.noTargetDesc)).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Spawn' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Character' })).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByText('TestPlayer'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'TestPlayer' })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.queryByText(en.dossier.noTargetTitle)).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })
    const giveXpCopy = await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === 'Grant experience to TestPlayer')
    expect(giveXpCopy).toBeInTheDocument()
    expect(screen.queryByText(en.spawn.giveXpDescNoPlayer)).not.toBeInTheDocument()
  })
})
