import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi, serverApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 19, client-vs-server permission gate sweep):
// this page had NO capability checks at all. server.js's lightning/thunder/
// horde routes and panelBridge.js's targeted gunshot/alarm/noise routes are
// gated on players.endanger_or_impersonate specifically -- a role can hold
// this page's baseline server.world_events without it (roles.json's own
// description explicitly contrasts the two) -- but every control that
// reaches them was fully enabled regardless of role, surfacing the refusal
// only as a 403 after the click.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
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
    serverApi: { ...actual.serverApi, triggerLightning: vi.fn(), triggerThunder: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      getWeather: vi.fn(),
      triggerGunshotBridge: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const triggerLightning = vi.mocked(serverApi.triggerLightning)
const triggerGunshotBridge = vi.mocked(panelBridgeApi.triggerGunshotBridge)

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
  getPlayers.mockReset().mockResolvedValue({ players: [{ name: 'Kate', online: true }] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getWeather.mockReset().mockResolvedValue({ success: false } as never)
  triggerLightning.mockReset().mockResolvedValue({ success: true } as never)
  triggerGunshotBridge.mockReset().mockResolvedValue({ success: true } as never)
})

async function openQuickSoundsSection() {
  const nav = await screen.findByText('Quick sounds')
  fireEvent.click(nav)
  await screen.findByRole('button', { name: 'lightning' })
}

describe('Events.tsx: lightning is gated on players.endanger_or_impersonate', () => {
  it('disables Lightning and never calls the API when the role lacks the capability', async () => {
    mockCan = (capability) => capability !== 'players.endanger_or_impersonate'
    renderEvents()
    await openQuickSoundsSection()

    const lightningButton = screen.getByRole('button', { name: 'lightning' })
    expect(lightningButton).toBeDisabled()

    fireEvent.click(lightningButton)
    expect(triggerLightning).not.toHaveBeenCalled()
  })

  it('enables Lightning when the role holds the capability', async () => {
    mockCan = () => true
    renderEvents()
    await openQuickSoundsSection()

    expect(screen.getByRole('button', { name: 'lightning' })).not.toBeDisabled()
  })
})

describe('Events.tsx: targeted sound (gunshot at world coordinates) is gated on players.endanger_or_impersonate', () => {
  it('disables the coords-targeted gunshot button when the role lacks the capability, even with valid coordinates', async () => {
    mockCan = (capability) => capability !== 'players.endanger_or_impersonate'
    renderEvents()

    const nav = await screen.findByText('Targeted sounds')
    fireEvent.click(nav)

    const xInput = await screen.findByLabelText('Sound world X coordinate')
    const yInput = await screen.findByLabelText('Sound world Y coordinate')
    fireEvent.change(xInput, { target: { value: '10500' } })
    fireEvent.change(yInput, { target: { value: '9800' } })

    // Both the player-targeted and coords-targeted gunshot buttons render
    // the identical text "gunshot" (they share one translation key) -- the
    // coords-targeted one is the second of the two in document order.
    const gunshotButtons = screen.getAllByRole('button', { name: 'gunshot' })
    expect(gunshotButtons).toHaveLength(2)
    const gunshotCoordsButton = gunshotButtons[1]
    expect(gunshotCoordsButton).toBeDisabled()

    fireEvent.click(gunshotCoordsButton)
    expect(triggerGunshotBridge).not.toHaveBeenCalled()
  })
})
