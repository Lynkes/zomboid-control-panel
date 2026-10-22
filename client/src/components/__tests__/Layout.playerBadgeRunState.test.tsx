import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// Console audit (2026-10-12): the Players badge in the sidebar only changed on
// a players:update push, which stops when the server does. A stopped server
// kept its last count (and so did the one just switched away from) on the nav
// link and the Users section dot. The count is shown only while the server is
// running, and reset when the active server changes.

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

const roster = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `p${i}` }))

describe('Layout.tsx: the sidebar player count belongs to a running server', () => {
  it('hides the count once the server stops, and shows it again when it runs', async () => {
    const { socket, fire } = fakeSocket()
    renderLayout(socket)
    await screen.findByText('the-active-server')
    expect(await screen.findByText('Server is running', {}, { timeout: 5000 })).toBeInTheDocument()

    act(() => fire('players:update', roster(7)))
    // Strip and Players nav link both carry the count.
    await waitFor(() => expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(2))

    act(() => fire('server:status', { running: false, phase: 'stopped' }))
    expect(await screen.findByText('Server is stopped')).toBeInTheDocument()
    expect(screen.queryByText('7')).not.toBeInTheDocument()

    act(() => fire('server:status', { running: true, phase: 'running' }))
    expect(await screen.findByText('Server is running')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(2))
  })

  it('forgets the previous server\'s count when the active server changes', async () => {
    const { socket, fire } = fakeSocket()
    renderLayout(socket)
    await screen.findByText('the-active-server')
    expect(await screen.findByText('Server is running', {}, { timeout: 5000 })).toBeInTheDocument()

    act(() => fire('players:update', roster(7)))
    await waitFor(() => expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(2))

    await act(async () => { fire('activeServerChanged', { server: { id: 2 } }) })

    await waitFor(() => expect(screen.queryByText('7')).not.toBeInTheDocument())
  })
})
