import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 16, following Console/Dashboard/Debug/Events/
// Players/Settings.activeServerRaceOrder.test.tsx): Chat.tsx's fetchPlayers
// (round 9's own fix, playersGuard via useRequestGuard) runs on mount, on a
// 15s poll, AND on activeServerChanged -- same race shape as the other five
// pages' own fetchStatus/fetchDiagnostics equivalents. A manual/poll call
// for the server that was active a moment ago, still in flight, could
// resolve AFTER the activeServerChanged-triggered call for the NEW server
// and silently overwrite its (correct, newer) player roster with a stale
// one. This proves playersGuard actually drops that late arrival.
//
// jsdom does not implement scrollIntoView -- Chat.tsx calls it on every
// chatHistory update (see Chat.capabilityGating.test.tsx's own citation,
// the first test file for this page to discover it).
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

// Chat.tsx reads the socket via useSocket() (useContext(SocketContext)) --
// same pattern as Debug.activeServerRaceOrder.test.tsx. Handler registry
// lives outside React so emitActiveServerChanged() can reach it independent
// of re-renders.
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

function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const mockedGetChatInfo = vi.mocked(panelBridgeApi.getChatInfo)
const mockedGetPlayers = vi.mocked(playersApi.getPlayers)
const mockedGetAppSettings = vi.mocked(configApi.getAppSettings)

function playersFixture(names: string[]) {
  return { players: names.map((name) => ({ name })) }
}

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

describe('Chat.tsx: an older, slower players response must not overwrite a newer one', () => {
  it('keeps the newer player roster when an earlier in-flight fetchPlayers resolves AFTER the activeServerChanged fetch', async () => {
    let playersCallCount = 0
    let resolveStalePlayers: (value: { players: { name: string }[] }) => void = () => {}
    const stalePlayers = new Promise<{ players: { name: string }[] }>((resolve) => { resolveStalePlayers = resolve })

    mockedGetChatInfo.mockResolvedValue({ success: true, data: { chatServerAvailable: true } } as never)
    mockedGetAppSettings.mockResolvedValue({} as never)
    mockedGetPlayers.mockImplementation(async () => {
      playersCallCount += 1
      // Call #1 (mount): resolves fast -- establishes the initial roster.
      if (playersCallCount === 1) return playersFixture(['Alice', 'Bob']) as never
      // Call #2 (a manual "Refresh" click, standing in for a slow poll
      // tick): held open, for whichever server was active when issued.
      if (playersCallCount === 2) return stalePlayers as never
      // Call #3 (activeServerChanged): resolves immediately with a
      // different roster, so a wrongly-applied stale response is visibly
      // distinguishable.
      return playersFixture(['Carol']) as never
    })

    renderChat()
    expect(await screen.findByText('2 online')).toBeInTheDocument()
    expect(playersCallCount).toBe(1)

    const refreshButton = await screen.findByRole('button', { name: /refresh/i })
    fireEvent.click(refreshButton)
    await waitFor(() => expect(playersCallCount).toBe(2))

    await act(async () => { emitActiveServerChanged() })
    await waitFor(() => expect(playersCallCount).toBe(3))
    expect(await screen.findByText('1 online')).toBeInTheDocument()

    // The stale call #2 finally lands, arriving strictly after call #3's
    // already-applied, newer roster.
    await act(async () => { resolveStalePlayers(playersFixture(['Alice', 'Bob'])) })

    // The bug: unguarded code has nothing gating this late apply, so it
    // silently reverts the roster back to the 2-player list even though the
    // newer, 1-player roster is confirmed current.
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('1 online')).toBeInTheDocument()
    expect(screen.queryByText('2 online')).not.toBeInTheDocument()
  })
})
