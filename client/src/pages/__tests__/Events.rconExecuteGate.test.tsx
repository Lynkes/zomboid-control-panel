import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi, serversApi, rconApi } from '@/lib/api'

// Time speed, both teleports and vehicle spawn send a raw RCON command
// through POST /rcon/execute (requirePermission('rcon.execute')). The
// default Moderator holds server.world_events but not rcon.execute: the
// buttons were enabled and every click ended in a 403 toast.

const MODERATOR = ['players.moderate', 'players.gm_tools', 'players.view', 'server.world_events']
const role = vi.hoisted(() => ({ capabilities: null as string[] | null }))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'custom', capabilities: role.capabilities },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => role.capabilities === null || role.capabilities.includes(capability),
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
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn() },
    rconApi: { ...actual.rconApi, execute: vi.fn() },
  }
})

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

beforeEach(() => {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'Kate' }, { name: 'Bob' }] } as never)
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ isRunning: true, modConnected: true } as never)
  vi.mocked(panelBridgeApi.getWeather).mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getClimateFloats).mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getGameTime).mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getUtilitiesStatus).mockResolvedValue({ success: false } as never)
  vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
    provider: 'native',
    selected: true,
    host: { status: 'running', label: 'Host', detail: null },
    server: { status: 'connected', label: 'RCON', detail: null },
    bridge: { status: 'active', label: 'PanelBridge', detail: null },
    summary: '',
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  role.capabilities = null
})

function renderAt(section: string) {
  return render(
    <MemoryRouter initialEntries={[`/events?section=${section}`]}>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Events.tsx: RCON-backed actions follow rcon.execute', () => {
  it('lets a role with rcon.execute use them', async () => {
    renderAt('timespeed')
    const apply = await screen.findByRole('button', { name: /apply speed/i })
    await waitFor(() => expect(apply).toBeEnabled())
    cleanup()

    renderAt('teleport')
    fireEvent.change(await screen.findByLabelText('Teleport X coordinate'), { target: { value: '10000' } })
    fireEvent.change(screen.getByLabelText('Teleport Y coordinate'), { target: { value: '11000' } })
    fireEvent.change(screen.getByLabelText('Teleport Z level'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: /teleport self/i })).toBeEnabled()
    cleanup()

    renderAt('vehicles')
    expect(await screen.findByRole('button', { name: 'Kate' })).toBeEnabled()
  })

  it('disables time speed, teleport and vehicle spawn for a Moderator', async () => {
    role.capabilities = MODERATOR
    renderAt('timespeed')
    expect(await screen.findByText('Bridge connected')).toBeInTheDocument()
    const apply = screen.getByRole('button', { name: /apply speed/i })
    expect(apply).toBeDisabled()
    fireEvent.click(apply)
    expect(rconApi.execute).not.toHaveBeenCalled()
    cleanup()

    renderAt('teleport')
    fireEvent.change(await screen.findByLabelText('Teleport X coordinate'), { target: { value: '10000' } })
    fireEvent.change(screen.getByLabelText('Teleport Y coordinate'), { target: { value: '11000' } })
    fireEvent.change(screen.getByLabelText('Teleport Z level'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: /teleport self/i })).toBeDisabled()
    cleanup()

    renderAt('vehicles')
    const spawnFor = await screen.findByRole('button', { name: 'Kate' })
    expect(spawnFor).toBeDisabled()
  })
})
