import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// The Game clock card is edited first and sent later with "apply time & date".
// The 10 s bridge poll wrote the game's own hour/day/month straight over the
// form (the climate sliders and time speed already had a dirty gate), so
// picking "dusk" and clicking apply a few seconds later applied the old hour:
// the pick had silently been reverted.

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
      setGameTime: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const setGameTime = vi.mocked(panelBridgeApi.setGameTime)

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
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getWeather.mockReset().mockResolvedValue({ success: false } as never)
  // The game itself sits at noon, 5 March, throughout.
  getGameTime.mockReset().mockResolvedValue({
    success: true,
    data: { hour: 12, day: 5, month: 3, multiplier: 1 },
  } as never)
  setGameTime.mockReset().mockResolvedValue({ success: true } as never)
})

async function openClockSection() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Game clock' })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('Events -- a Game clock pick that is not applied yet survives the bridge poll', () => {
  it('keeps "dusk" on screen and sends it, even when apply comes after a poll tick', async () => {
    vi.useFakeTimers()
    try {
      renderEvents()
      await openClockSection()
      expect(screen.getByText('12:00')).toBeTruthy()

      act(() => { fireEvent.click(screen.getByRole('button', { name: /dusk/i })) })
      expect(screen.getByText('18:00')).toBeTruthy()

      // Two 10 s bridge polls go by before the operator clicks apply; each
      // one reads noon back from the game.
      await act(async () => { await vi.advanceTimersByTimeAsync(21000) })
      expect(getGameTime.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(screen.getByText('18:00')).toBeTruthy()
      expect(screen.queryByText('12:00')).not.toBeInTheDocument()

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /apply time & date/i })) })
      expect(setGameTime).toHaveBeenCalledWith({ hour: 18, day: 5, month: 3 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes back to following the game clock once the pick has been applied', async () => {
    vi.useFakeTimers()
    try {
      renderEvents()
      await openClockSection()

      act(() => { fireEvent.click(screen.getByRole('button', { name: /dusk/i })) })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /apply time & date/i })) })
      expect(setGameTime).toHaveBeenCalledTimes(1)

      // The game did not take the change (it still reports noon): the next
      // poll shows what the game says rather than the old pick.
      await act(async () => { await vi.advanceTimersByTimeAsync(11000) })
      expect(screen.getByText('12:00')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
