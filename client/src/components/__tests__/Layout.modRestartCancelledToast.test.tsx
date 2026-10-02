import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { SocketContext } from '@/contexts/SocketContext'
import { Toaster } from '@/components/ui/toaster'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'
import en from '@/locales/en/mods.json'

// GH #189: a mod-update restart waiting for players ends when the server is
// started again after the update (that start loaded the updated mods). The
// server says so with mods:restart_cancelled { reason: 'server_restarted' },
// and Layout tells the operator wherever they are -- usually the Dashboard
// they just restarted from. An operator's own Cancel on the Mods page sends
// no reason and stays silent here.

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
  return { socket: socket as unknown as Socket, fire, handlers }
}

function renderLayout(socket: Socket) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
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
        <Toaster />
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout: GH #189 mod-update restart cancelled by a server start', () => {
  // One test: the toast store is module-wide, so a toast shown by one test
  // would still be on screen in the next.
  it("toasts why the pending restart won't happen, and stays silent for the operator's own Cancel", async () => {
    const { socket, fire, handlers } = fakeSocket()
    renderLayout(socket)
    await screen.findByText('page content')
    expect(handlers.get('mods:restart_cancelled')?.size).toBe(1)

    act(() => fire('mods:restart_cancelled', {}))
    expect(screen.queryByText(en.restartPending.cancelledByRestartTitle)).not.toBeInTheDocument()

    act(() => fire('mods:restart_cancelled', { reason: 'server_restarted' }))
    expect(await screen.findByText(en.restartPending.cancelledByRestartTitle)).toBeInTheDocument()
    expect(screen.getByText(en.restartPending.cancelledByRestartDesc)).toBeInTheDocument()
  })
})
