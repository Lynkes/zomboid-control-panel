import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// Browsers that block site data make localStorage throw instead of returning
// null. The shell read it while rendering, so one blocked read took the whole
// panel down; now it just forgets the sidebar and the dismissed banner
// between visits.

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

function stubDesktop() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1024px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

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

function renderLayout(socket: Socket | null = null) {
  const view = render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <Layout>
          <div>page content</div>
        </Layout>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
  const aside = view.container.querySelector('aside')!
  return { aside, footer: () => within(aside.lastElementChild as HTMLElement) }
}

function blockStorage() {
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
}

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: false } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Layout with browser storage blocked', () => {
  it('still renders the shell and lets the sidebar collapse and expand', async () => {
    stubDesktop()
    blockStorage()
    const { footer } = renderLayout()
    expect(await screen.findByText('page content')).toBeInTheDocument()

    fireEvent.click(await footer().findByRole('button', { name: 'Collapse sidebar' }))
    expect(await footer().findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()

    fireEvent.click(footer().getByRole('button', { name: 'Expand sidebar' }))
    expect(await footer().findByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
  })

  it('shows the server-update banner and dismisses it for the visit', async () => {
    blockStorage()
    const { socket, fire } = fakeSocket()
    renderLayout(socket)
    await screen.findByText('page content')

    act(() =>
      fire('server:updateAvailable', {
        updateAvailable: true,
        installed: { buildId: '100', branch: 'unstable' },
        latest: { buildId: '101', description: 'Fixes' },
      }),
    )
    expect(await screen.findByText('Server update')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Server update')).not.toBeInTheDocument()
  })
})
