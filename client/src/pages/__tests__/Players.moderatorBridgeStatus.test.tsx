import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { ApiError, playersApi, panelBridgeApi, configApi, serversApi } from '@/lib/api'

// The default Moderator holds players.gm_tools but neither bridge.setup nor
// bridge.diagnostics, the only capabilities GET /panel-bridge/status answers.
// The page read that route's 403 as "bridge offline", so a Moderator's God
// mode, Invisible, Noclip and Heal were greyed out ("PanelBridge required")
// while the bridge ran fine. The bridge signal of GET /servers/active/status
// is readable by every role.

const MODERATOR = ['players.moderate', 'players.gm_tools', 'players.view', 'server.world_events']

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'mod', role: 'moderator', capabilities: MODERATOR },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => MODERATOR.includes(capability),
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
      sendCommand: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn() },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

function setUpFixtures() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [] })
  vi.mocked(playersApi.getStats).mockResolvedValue({ stats: [] })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  // What the server answers this role on the detailed route.
  vi.mocked(panelBridgeApi.getStatus).mockRejectedValue(
    new ApiError('Insufficient permissions', { status: 403, code: 'PERMISSION_DENIED' }),
  )
  vi.mocked(panelBridgeApi.getAllPlayerDetails).mockResolvedValue({ success: false } as never)
  vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
    provider: 'native',
    selected: true,
    host: { status: 'running', label: 'Host', detail: null },
    server: { status: 'connected', label: 'RCON', detail: null },
    bridge: { status: 'active', label: 'PanelBridge', detail: null },
    summary: '',
  })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: a Moderator sees the bridge as it is', () => {
  it('keeps the powers usable when the bridge is up, without asking the route this role cannot read', async () => {
    setUpFixtures()
    render(
      <MemoryRouter initialEntries={['/players?player=TestPlayer&tab=powers']}>
        <TooltipProvider>
          <Players />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Powers' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    const heal = await screen.findByRole('button', { name: 'Heal' }, { timeout: 3000 })
    await waitFor(() => expect(heal).toBeEnabled())
    expect(screen.getAllByRole('button', { name: 'Enable' })[0]).toBeEnabled()
    expect(panelBridgeApi.getStatus).not.toHaveBeenCalled()
    expect(serversApi.getComposedStatus).toHaveBeenCalled()
  })
})
