import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// UX restructure (slice C): spawning a horde lands zombies on a real player
// in the middle of whatever they are doing -- the same affects-someone-else
// but recoverable tier as clearing zombies near a player, which already asks
// first. Spawning now asks the same way (variant 'warning'), naming how many
// zombies and who they land on, and nothing is sent until it is accepted.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      getWeather: vi.fn(),
      spawnHordeNear: vi.fn(),
      spawnHordeBehind: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const spawnHordeNear = vi.mocked(panelBridgeApi.spawnHordeNear)
const spawnHordeBehind = vi.mocked(panelBridgeApi.spawnHordeBehind)

function renderHorde() {
  return render(
    <MemoryRouter initialEntries={['/events?section=horde']}>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // One online player: the "all online" random pick resolves to Kate.
  getPlayers.mockReset().mockResolvedValue({ players: [{ name: 'Kate', online: true }] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  vi.mocked(panelBridgeApi.getClimateFloats).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getGameTime).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getUtilitiesStatus).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getWeather).mockReset().mockResolvedValue({ success: false } as never)
  spawnHordeNear.mockReset().mockResolvedValue({ success: true } as never)
  spawnHordeBehind.mockReset().mockResolvedValue({ success: true } as never)
})

// Re-query: while the roster loads, DisabledReason wraps the disabled button,
// so the enabled one is a different element.
async function spawnButton(name: string) {
  await waitFor(() => expect(screen.getByRole('button', { name })).not.toBeDisabled())
  return screen.getByRole('button', { name })
}

describe('Events -- spawning a horde asks first, like clearing zombies near a player', () => {
  it('sends nothing until the warning confirm is accepted, and nothing at all when cancelled', async () => {
    renderHorde()
    ;(await spawnButton('spawn near random')).click()

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Spawn 50 zombies?')).toBeInTheDocument()
    expect(within(dialog).getByText(/random online player/)).toBeInTheDocument()
    expect(spawnHordeNear).not.toHaveBeenCalled()

    within(dialog).getByRole('button', { name: 'Cancel' }).click()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(spawnHordeNear).not.toHaveBeenCalled()
  })

  it('spawns near the resolved player once confirmed', async () => {
    renderHorde()
    ;(await spawnButton('spawn near random')).click()

    const dialog = await screen.findByRole('alertdialog')
    within(dialog).getByRole('button', { name: 'spawn near random' }).click()

    await waitFor(() => expect(spawnHordeNear).toHaveBeenCalledWith('Kate', 50))
    expect(spawnHordeBehind).not.toHaveBeenCalled()
  })

  it('asks before spawning behind a player too', async () => {
    renderHorde()
    ;(await spawnButton('spawn behind random')).click()

    const dialog = await screen.findByRole('alertdialog')
    expect(spawnHordeBehind).not.toHaveBeenCalled()
    within(dialog).getByRole('button', { name: 'spawn behind random' }).click()

    await waitFor(() => expect(spawnHordeBehind).toHaveBeenCalledWith('Kate', 50))
  })
})
