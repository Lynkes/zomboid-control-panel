import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { SocketContext } from '@/contexts/SocketContext'
import { Toaster } from '@/components/ui/toaster'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// A restart started from the Dashboard's list of servers runs for minutes
// (the players' warning first) on a server other than the active one. Its
// outcome comes back as the Dashboard's own Restart's does
// (scheduler:action_result), with the server's name, so the toast says which
// server it was instead of "Restart completed" for the one on screen.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: false,
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
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
  }
})

function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
      return socket
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler)
      return socket
    }),
    emit: vi.fn(),
    connected: true,
  }
  const fire = (event: string, payload?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  return { socket: socket as unknown as Socket, fire }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout: the outcome of a restart of another server', () => {
  // One test: the toast store is module-wide.
  it('names the server it restarted, and the one it failed to', async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
    vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
    vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
    vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
    vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.4.8' }) })))
    const { socket, fire } = fakeSocket()
    render(
      <MemoryRouter>
        <SocketContext.Provider value={socket}>
          <Layout>
            <div>page content</div>
          </Layout>
          <Toaster />
        </SocketContext.Provider>
      </MemoryRouter>,
    )
    await screen.findByText('page content')

    act(() => fire('scheduler:action_result', {
      kind: 'restart', serverName: 'LNK-OUTBREAK', success: true, message: 'Server restarted successfully',
    }))
    expect(await screen.findByText('LNK-OUTBREAK restarted')).toBeInTheDocument()

    act(() => fire('scheduler:action_result', {
      kind: 'restart', serverName: 'Arena', success: false, message: 'RCON not available: timeout',
    }))
    expect(await screen.findByText('Arena wasn\'t restarted')).toBeInTheDocument()
    expect(screen.getByText('RCON not available: timeout')).toBeInTheDocument()
  })
})
