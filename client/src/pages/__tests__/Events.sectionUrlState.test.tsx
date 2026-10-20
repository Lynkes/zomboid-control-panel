import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// UX restructure (slice C): the Events sections are a SubNav whose
// selection lives in ?section= (the command palette's deep links use the
// same ids), so a reload or a link opens the same section; and every
// "bridge offline" message links to the one place it is fixed,
// /settings?tab=bridge.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

const mockCan = vi.hoisted(() => vi.fn((_capability: string) => true))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: mockCan,
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
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      getWeather: vi.fn(),
      sendCommand: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(panelBridgeApi.getStatus)

let lastSearch = ''
function LocationProbe() {
  lastSearch = useLocation().search
  return null
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
          <LocationProbe />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// The open section's card title is the page's one h2 for that section.
const sectionHeading = (name: string) => screen.findByRole('heading', { level: 2, name })

beforeEach(() => {
  mockCan.mockImplementation(() => true)
  vi.mocked(playersApi.getPlayers).mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  vi.mocked(panelBridgeApi.getClimateFloats).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getGameTime).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getUtilitiesStatus).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getWeather).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.sendCommand).mockReset().mockResolvedValue({ success: true, data: {} } as never)
})

describe('Events -- the open section lives in ?section=', () => {
  it('opens the section the URL names', async () => {
    renderAt('/events?section=horde')
    expect(await sectionHeading('Spawn horde')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spawn horde' })).toHaveAttribute('aria-current', 'true')
  })

  it('writes the picked section back and opens it again after a remount', async () => {
    renderAt('/events')
    expect(await sectionHeading('Rain and storms')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Game clock' }))
    expect(await sectionHeading('Game clock')).toBeInTheDocument()
    expect(new URLSearchParams(lastSearch).get('section')).toBe('clock')

    const reloadAt = `/events${lastSearch}`
    cleanup()
    renderAt(reloadAt)
    expect(await sectionHeading('Game clock')).toBeInTheDocument()
  })

  it('reads an unknown section as the first one', async () => {
    renderAt('/events?section=nope')
    expect(await sectionHeading('Rain and storms')).toBeInTheDocument()
  })

  it('never opens Bridge tools for a role without bridge.command, even from a link', async () => {
    mockCan.mockImplementation((capability: string) => capability !== 'bridge.command')
    renderAt('/events?section=bridgeOps')
    expect(await sectionHeading('Rain and storms')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Bridge tools' })).not.toBeInTheDocument()
  })
})

describe('Events -- bridge-offline messages link to Settings › PanelBridge', () => {
  it('points the page alert and the header badge at /settings?tab=bridge, never bare /settings', async () => {
    getStatus.mockResolvedValue({ modConnected: false } as never)
    const { container } = renderAt('/events?section=severe')

    const fix = await screen.findByRole('link', { name: 'Open PanelBridge settings' })
    expect(fix).toHaveAttribute('href', '/settings?tab=bridge')
    expect(screen.getByText('PanelBridge is offline')).toBeInTheDocument()

    const badge = screen.getByText('Bridge offline').closest('a')
    expect(badge).toHaveAttribute('href', '/settings?tab=bridge')

    expect(container.querySelector('a[href="/settings"]')).toBeNull()
  })

  it('shows no bridge-offline alert on a section that works over RCON', async () => {
    getStatus.mockResolvedValue({ modConnected: false } as never)
    renderAt('/events?section=rain')
    await waitFor(() => expect(screen.getByText('Bridge offline')).toBeInTheDocument())
    expect(screen.queryByText('PanelBridge is offline')).not.toBeInTheDocument()
  })
})
