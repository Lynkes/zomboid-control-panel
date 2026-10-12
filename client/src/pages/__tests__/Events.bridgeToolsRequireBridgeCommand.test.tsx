import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// The Bridge tools section and the safehouse/faction lists that fill its
// pickers go through POST /panel-bridge/command, which needs bridge.command.
// The default Technician and Moderator roles do not hold it, so the page
// polled getSafehouses/getFactions every 30 s into a 403 for them, showed a
// permanent "could not refresh lists" message and left the section's buttons
// enabled. Without the capability the section is hidden and nothing is polled.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      getWeather: vi.fn(),
      sendCommand: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

function renderEvents() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockCan = () => true
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getWeather.mockReset().mockResolvedValue({ success: false } as never)
  sendCommand.mockReset().mockResolvedValue({ success: true, data: { safehouses: [], factions: [] } } as never)
})

describe('Events.tsx: Bridge tools need bridge.command', () => {
  it('hides the section and never polls the safehouse/faction lists without bridge.command', async () => {
    mockCan = (capability) => capability !== 'bridge.command'
    vi.useFakeTimers()
    try {
      renderEvents()
      // Long enough for the bridge to read as connected and for two 30 s
      // option polls to have come due.
      await act(async () => { await vi.advanceTimersByTimeAsync(65000) })

      expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(sendCommand).not.toHaveBeenCalled()
      expect(screen.queryByText('Bridge tools')).not.toBeInTheDocument()
      // The group that held only that section goes with it.
      expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
      // The rest of the page is untouched.
      expect(screen.getByText('Quick sounds')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists the section and loads the safehouse and faction lists with bridge.command', async () => {
    vi.useFakeTimers()
    try {
      renderEvents()
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

      expect(screen.getByText('Bridge tools')).toBeInTheDocument()
      const actions = sendCommand.mock.calls.map((call) => call[0])
      expect(actions).toContain('getSafehouses')
      expect(actions).toContain('getFactions')
    } finally {
      vi.useRealTimers()
    }
  })
})
