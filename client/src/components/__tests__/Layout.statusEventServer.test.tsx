import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// Restarting the tasks of a server that is NOT the active one flipped the
// sidebar's Active Server dot. scheduler.js pushes server:status at its own
// verified stop/start transitions and the push carried no server id, so the
// sidebar read "stopped" for the whole restart of a server it wasn't showing.
// The push now names the server it is about (serverId); a push naming another
// server is applied to nothing here, and one naming the active server (or none,
// as every other push) still moves the dot.

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

const ACTIVE_SERVER = {
  id: 1,
  name: 'the-active-server',
  serverName: 'a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/a.ini',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

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

function renderLayout(socket: Socket) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [ACTIVE_SERVER] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.4.2' }) })),
  )
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <Layout>
          <div>page content</div>
        </Layout>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout.tsx: sidebar dot follows server:status only for the active server', () => {
  it('ignores a push naming another server, applies one naming the active server, and one naming none', async () => {
    const { socket, fire } = fakeSocket()
    renderLayout(socket)

    await screen.findByText('the-active-server')
    expect(await screen.findByText('Server is running', {}, { timeout: 5000 })).toBeInTheDocument()

    // A scheduled task restarting server 2 (not shown here) reports its old
    // process gone: nothing happens to server 1's dot.
    act(() => fire('server:status', { running: false, phase: 'stopped', serverId: 2 }))
    expect(screen.getByText('Server is running')).toBeInTheDocument()
    expect(screen.queryByText('Server is stopped')).not.toBeInTheDocument()

    // The same event naming the active server (1; a string id must match too)
    // is the truth for this dot.
    act(() => fire('server:status', { running: false, phase: 'stopped', serverId: '1' }))
    expect(await screen.findByText('Server is stopped')).toBeInTheDocument()

    // An unlabelled push (every other emit site) is about the active server.
    act(() => fire('server:status', { running: true, phase: 'running' }))
    expect(await screen.findByText('Server is running')).toBeInTheDocument()

    // And the foreign one still changes nothing after the others.
    act(() => fire('server:status', { running: false, phase: 'stopped', serverId: 2 }))
    expect(screen.getByText('Server is running')).toBeInTheDocument()
  })
})
