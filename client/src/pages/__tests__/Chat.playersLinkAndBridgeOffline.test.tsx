import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Chat from '../Chat'
import { ApiError, configApi, panelBridgeApi, playersApi } from '@/lib/api'

// UX restructure (slice C): an online player opens in Players, the header
// button says it only refreshes players, and a PanelBridge that isn't
// running (every channel then goes out over RCON only; server broadcasts
// still work, admin chat reaches every player) is said once, with a link to
// the bridge settings.

Element.prototype.scrollIntoView = vi.fn()

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
    panelBridgeApi: { ...actual.panelBridgeApi, getChatInfo: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
  }
})

const socketHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
const fakeSocket = {
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

const getChatInfo = vi.mocked(panelBridgeApi.getChatInfo)
const getPlayers = vi.mocked(playersApi.getPlayers)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function renderChat() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <SocketContext.Provider value={fakeSocket}>
            <Chat />
          </SocketContext.Provider>
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Chat online players', () => {
  it('link each player to the Players page', async () => {
    getChatInfo.mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    getAppSettings.mockResolvedValue({} as never)
    getPlayers.mockResolvedValue({ players: [{ name: 'Alice' }, { name: 'Bob Smith' }] } as never)

    renderChat()
    expect(await screen.findByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/players?player=Alice')
    expect(screen.getByRole('link', { name: 'Bob Smith' })).toHaveAttribute('href', '/players?player=Bob%20Smith')
  })

  it('names the header button after what it refreshes', async () => {
    getChatInfo.mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    getAppSettings.mockResolvedValue({} as never)
    getPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    const button = await screen.findByRole('button', { name: 'Refresh players' })
    await waitFor(() => expect(getPlayers).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    await waitFor(() => expect(getPlayers).toHaveBeenCalledTimes(2))
  })
})

describe('Chat with PanelBridge not running', () => {
  it('says so once and links to the PanelBridge settings', async () => {
    getChatInfo.mockRejectedValue(new ApiError('Bridge not running', { status: 400, code: 'BRIDGE_NOT_RUNNING_BARE' }))
    getAppSettings.mockResolvedValue({} as never)
    getPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    const alert = await screen.findByText("PanelBridge isn't running")
    const box = alert.closest('[role="status"]') as HTMLElement
    expect(within(box).getByRole('link', { name: 'PanelBridge settings' })).toHaveAttribute('href', '/settings?tab=bridge')
    // /chat/alert sends a plain broadcast over RCON first: it still works.
    expect(box).toHaveTextContent('Server broadcasts still go out over RCON')
    expect(box).not.toHaveTextContent("can't be sent")
  })

  it('stays quiet for other chat-info failures, and clears after a server switch', async () => {
    getChatInfo.mockRejectedValueOnce(new ApiError('Bridge not running', { status: 400, code: 'BRIDGE_NOT_RUNNING_BARE' }))
    getChatInfo.mockResolvedValueOnce({ success: true, data: { chatServerAvailable: true } } as never)
    getAppSettings.mockResolvedValue({} as never)
    getPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    await screen.findByText("PanelBridge isn't running")
    await act(async () => {
      socketHandlers.get('activeServerChanged')?.forEach((handler) => handler())
    })
    await waitFor(() => expect(getChatInfo).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText("PanelBridge isn't running")).not.toBeInTheDocument())
    expect(await screen.findByText('Chat delivery: native')).toBeInTheDocument()
  })

  it('does not blame the bridge for an unrelated error', async () => {
    getChatInfo.mockRejectedValue(new ApiError('boom', { status: 500 }))
    getAppSettings.mockResolvedValue({} as never)
    getPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    await waitFor(() => expect(getChatInfo).toHaveBeenCalled())
    await screen.findByText('No players connected')
    expect(screen.queryByText("PanelBridge isn't running")).not.toBeInTheDocument()
  })
})
