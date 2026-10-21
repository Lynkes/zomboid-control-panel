import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { ApiError, playersApi, panelBridgeApi, serversApi } from '@/lib/api'

// The default Moderator holds server.world_events (weather, climate, clock,
// utilities) but neither bridge.setup nor bridge.diagnostics, the only
// capabilities GET /panel-bridge/status answers. Its 403 read as "bridge
// offline": the header said Bridge offline, the page alert sent the operator
// to settings they can't open, and every bridge control was disabled.

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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getWeather: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      sendCommand: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn() },
  }
})

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

beforeEach(() => {
  vi.mocked(playersApi.getPlayers).mockReset().mockResolvedValue({ players: [] } as never)
  vi.mocked(panelBridgeApi.getStatus).mockReset().mockRejectedValue(
    new ApiError('Insufficient permissions', { status: 403, code: 'PERMISSION_DENIED' }),
  )
  vi.mocked(panelBridgeApi.getWeather).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getClimateFloats).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getGameTime).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getUtilitiesStatus).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(serversApi.getComposedStatus).mockReset().mockResolvedValue({
    provider: 'native',
    selected: true,
    host: { status: 'running', label: 'Host', detail: null },
    server: { status: 'connected', label: 'RCON', detail: null },
    bridge: { status: 'active', label: 'PanelBridge', detail: null },
    summary: '',
  })
})

describe('Events.tsx: a Moderator sees the bridge as it is', () => {
  it('shows the bridge connected and reads the live weather, without asking the route this role cannot read', async () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <Events />
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Bridge connected')).toBeInTheDocument()
    expect(screen.queryByText('Bridge offline')).not.toBeInTheDocument()
    expect(panelBridgeApi.getClimateFloats).toHaveBeenCalled()
    expect(panelBridgeApi.getStatus).not.toHaveBeenCalled()
  })
})
