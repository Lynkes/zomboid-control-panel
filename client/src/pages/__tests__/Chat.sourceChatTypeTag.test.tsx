import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// bug-hunt-2026-09-18 (in-panel chat): ground-truthed against the PZ server
// jar (zombie/network/chat/ChatServer's processMessageFromPlayerPacket logs
// EVERY player-submitted chat room's message -- whisper/faction/safehouse/
// radio included, not just public talking -- through the one "Got message:"
// line logTailer.js parses) and the server's own en/UI.json chat titles
// (chat=Private is a whisper). Before this fix, sourceChatType was computed
// by logTailer.js but dropped at the socket.io "chat:message" boundary
// (server/index.js), so Chat.tsx had no way to tell a private whisper
// between two players apart from ordinary public chat -- both rendered
// identically. This proves the client now shows a distinguishing tag once
// the server forwards the field (see chatSocketPayloadSourceChatType.test.js
// for the server-side half of this fix).
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

function emitChatMessage(data: Record<string, unknown>) {
  socketHandlers.get('chat:message')?.forEach((h) => h(data))
}

const mockedGetChatInfo = vi.mocked(panelBridgeApi.getChatInfo)
const mockedGetPlayers = vi.mocked(playersApi.getPlayers)
const mockedGetAppSettings = vi.mocked(configApi.getAppSettings)

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

describe('Chat.tsx: a non-public chat room is tagged, not shown as plain chat', () => {
  it('tags a whisper (chat=Private) so it reads differently from public chat', async () => {
    mockedGetChatInfo.mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    mockedGetAppSettings.mockResolvedValue({} as never)
    mockedGetPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    await screen.findByText('no players connected')

    await act(async () => {
      emitChatMessage({
        id: 'w1',
        type: 'general',
        author: 'Alice',
        message: 'meet me at the shed',
        timestamp: new Date().toISOString(),
        sourceChatType: 'Private',
      })
    })

    expect(await screen.findByText('[Whisper] Alice')).toBeInTheDocument()
    expect(screen.getByText('meet me at the shed')).toBeInTheDocument()
  })

  it('tags Faction/Safehouse/Radio the same way', async () => {
    mockedGetChatInfo.mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    mockedGetAppSettings.mockResolvedValue({} as never)
    mockedGetPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    await screen.findByText('no players connected')

    await act(async () => {
      emitChatMessage({ id: 'f1', type: 'general', author: 'Bob', message: 'faction msg', timestamp: new Date().toISOString(), sourceChatType: 'Faction' })
      emitChatMessage({ id: 's1', type: 'general', author: 'Cara', message: 'safehouse msg', timestamp: new Date().toISOString(), sourceChatType: 'Safehouse' })
      emitChatMessage({ id: 'r1', type: 'general', author: 'Dan', message: 'radio msg', timestamp: new Date().toISOString(), sourceChatType: 'Radio' })
    })

    expect(await screen.findByText('[Faction] Bob')).toBeInTheDocument()
    expect(screen.getByText('[Safehouse] Cara')).toBeInTheDocument()
    expect(screen.getByText('[Radio] Dan')).toBeInTheDocument()
  })

  it('leaves ordinary public chat (General/Local, or no sourceChatType at all) untagged', async () => {
    mockedGetChatInfo.mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    mockedGetAppSettings.mockResolvedValue({} as never)
    mockedGetPlayers.mockResolvedValue({ players: [] } as never)

    renderChat()
    await screen.findByText('no players connected')

    await act(async () => {
      emitChatMessage({ id: 'g1', type: 'general', author: 'Eve', message: 'hi all', timestamp: new Date().toISOString(), sourceChatType: 'General' })
      emitChatMessage({ id: 'l1', type: 'general', author: 'Finn', message: 'hey', timestamp: new Date().toISOString(), sourceChatType: 'Local' })
      emitChatMessage({ id: 'n1', type: 'general', author: 'Gus', message: 'no source type', timestamp: new Date().toISOString() })
    })

    expect(await screen.findByText('Eve')).toBeInTheDocument()
    expect(screen.getByText('Finn')).toBeInTheDocument()
    expect(screen.getByText('Gus')).toBeInTheDocument()
    expect(screen.queryByText(/\[Whisper\]|\[Faction\]|\[Safehouse\]|\[Radio\]|\[Shout\]/)).not.toBeInTheDocument()
  })
})
