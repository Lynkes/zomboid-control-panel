import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi, serverApi } from '@/lib/api'

// UX restructure (slice C): edits that only reach the game once the
// operator applies or sends them -- a typed announcement, a Game clock pick
// waiting for "Apply time & date" -- register the unsaved-changes guard, so
// leaving the page (or closing the tab) asks first. Once sent or applied,
// they no longer hold the page.

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
    serverApi: { ...actual.serverApi, sendMessage: vi.fn() },
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

const sendMessage = vi.mocked(serverApi.sendMessage)
const setGameTime = vi.mocked(panelBridgeApi.setGameTime)

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// useUnsavedChangesGuard adds the browser's leave-page prompt while dirty.
function leavingWouldAsk(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  vi.mocked(playersApi.getPlayers).mockReset().mockResolvedValue({ players: [] } as never)
  vi.mocked(panelBridgeApi.getStatus).mockReset().mockResolvedValue({ modConnected: true } as never)
  vi.mocked(panelBridgeApi.getClimateFloats).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getGameTime).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getUtilitiesStatus).mockReset().mockResolvedValue({ success: false } as never)
  vi.mocked(panelBridgeApi.getWeather).mockReset().mockResolvedValue({ success: false } as never)
  sendMessage.mockReset().mockResolvedValue({ success: true } as never)
  setGameTime.mockReset().mockResolvedValue({ success: true } as never)
})

describe('Events -- unsent edits hold the page', () => {
  it('a typed announcement asks before leaving until it is sent', async () => {
    renderAt('/events?section=broadcast')
    const message = await screen.findByLabelText('Server announcement message')
    expect(leavingWouldAsk()).toBe(false)

    fireEvent.change(message, { target: { value: 'Restart in 5 minutes' } })
    expect(leavingWouldAsk()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'broadcast message' }))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('Restart in 5 minutes'))
    await waitFor(() => expect(leavingWouldAsk()).toBe(false))
  })

  it('a Game clock pick asks before leaving until it is applied', async () => {
    renderAt('/events?section=clock')
    const dusk = await screen.findByRole('button', { name: /dusk/i })
    await waitFor(() => expect(dusk).not.toBeDisabled())
    expect(leavingWouldAsk()).toBe(false)

    fireEvent.click(dusk)
    expect(leavingWouldAsk()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /apply time & date/i }))
    await waitFor(() => expect(setGameTime).toHaveBeenCalled())
    await waitFor(() => expect(leavingWouldAsk()).toBe(false))
  })
})
