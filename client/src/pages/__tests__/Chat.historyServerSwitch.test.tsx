import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// Console audit (2026-10-12): the Chat page kept the lines it had shown across
// an active-server switch, and a chat:message carries no server id, so the
// previous server's chat stayed on screen under the new server's name next to
// its own lines. The page clears on activeServerChanged. (There is no chat
// history endpoint to refetch: the page is a live view of the log tailer,
// which the switch repoints.)

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

function fire(event: string, payload?: unknown) {
  socketHandlers.get(event)?.forEach((h) => h(payload))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Chat.tsx: the chat shown belongs to the active server', () => {
  it('clears the lines of the previous server on activeServerChanged and shows the new server\'s afterwards', async () => {
    vi.mocked(panelBridgeApi.getChatInfo).mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    vi.mocked(configApi.getAppSettings).mockResolvedValue({} as never)
    vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] } as never)

    render(
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
    await waitFor(() => expect(socketHandlers.get('chat:message')?.size).toBe(1))

    act(() => fire('chat:message', { id: 'a1', type: 'general', author: 'Alice', message: 'hello from server one' }))
    expect(await screen.findByText('hello from server one')).toBeInTheDocument()

    await act(async () => { fire('activeServerChanged') })
    expect(screen.queryByText('hello from server one')).not.toBeInTheDocument()

    act(() => fire('chat:message', { id: 'b1', type: 'general', author: 'Bob', message: 'hello from server two' }))
    expect(await screen.findByText('hello from server two')).toBeInTheDocument()
    expect(screen.queryByText('hello from server one')).not.toBeInTheDocument()
  })
})
