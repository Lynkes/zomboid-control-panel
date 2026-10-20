import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// UX restructure (slice B): one way to add a server. The Servers header has
// one command primary, "Add server", whose menu lists the three standard
// choices; a confirmed-empty roster shows the same choices; and
// /servers?add=existing|remote (linked from the Dashboard and Add a Server)
// opens the matching dialog. The header renders while the list loads.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      getComposedStatus: vi.fn(),
      discoverMounts: vi.fn(),
    },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)

const SERVER = {
  id: 1,
  name: 'alpha',
  serverName: 'alpha-cfg',
  installPath: '/srv/alpha',
  zomboidDataPath: '/srv/alpha/data',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  isRemote: false,
  isActive: false,
} as never

function mockFetches(servers: unknown[]) {
  getAll.mockResolvedValue({ servers } as never)
  vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('none'))
  vi.mocked(serversApi.discoverMounts).mockResolvedValue({ candidates: [] } as never)
  vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  vi.mocked(dockerApi.getStats).mockResolvedValue({ containers: {} } as never)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function renderServers(path = '/servers') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/servers" element={<Servers />} />
              <Route path="*" element={null} />
            </Routes>
            <Where />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

async function openAddMenu() {
  const trigger = await screen.findByRole('button', { name: en.addServer.menu })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers: the "Add a server" entry points', () => {
  it('renders the header (title and Add server) while the list is still loading', async () => {
    getAll.mockReturnValue(new Promise(() => {}))
    mockFetches([])
    getAll.mockReturnValue(new Promise(() => {}))
    renderServers()
    expect(screen.getByRole('heading', { level: 1, name: en.pageHeader.title })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.addServer.menu })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: en.loadingLabel })).toHaveAttribute('aria-busy', 'true')
  })

  it('the header menu lists the three choices; Install opens Add a Server in fresh mode', async () => {
    mockFetches([SERVER])
    renderServers()
    await screen.findByText('alpha')
    const menu = await openAddMenu()
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.querySelector('.font-medium')?.textContent)).toEqual([
      en.addServer.fresh.label,
      en.addServer.existing.label,
      en.addServer.remote.label,
    ])
    fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(en.addServer.fresh.label) }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/server-setup?mode=fresh'))
  })

  it('"Use existing server files" in the header menu opens the Add Existing Server dialog', async () => {
    mockFetches([SERVER])
    renderServers()
    await screen.findByText('alpha')
    const menu = await openAddMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(en.addServer.existing.label) }))
    expect(await screen.findByRole('heading', { name: en.addDialog.titleLocal })).toBeInTheDocument()
  })

  it('?add=remote opens the remote dialog, then drops the parameter', async () => {
    mockFetches([SERVER])
    renderServers('/servers?add=remote&keep=1')
    expect(await screen.findByRole('heading', { name: en.addDialog.titleRemote })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/servers\?keep=1$/))
  })

  it('?add=existing opens the existing-files dialog', async () => {
    mockFetches([SERVER])
    renderServers('/servers?add=existing')
    expect(await screen.findByRole('heading', { name: en.addDialog.titleLocal })).toBeInTheDocument()
  })

  it('an empty roster offers the same three choices; Connect a remote server opens its dialog in place', async () => {
    mockFetches([])
    renderServers()
    const list = await screen.findByRole('list', { name: en.addServer.listLabel })
    expect(within(list).getByRole('link', { name: new RegExp(en.addServer.fresh.label) })).toHaveAttribute('href', '/server-setup?mode=fresh')
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(en.addServer.remote.label) }))
    expect(await screen.findByRole('heading', { name: en.addDialog.titleRemote })).toBeInTheDocument()
  })

  it('links to the public server list from the header', async () => {
    mockFetches([SERVER])
    renderServers()
    expect(await screen.findByRole('link', { name: en.pageHeader.publicServers })).toHaveAttribute('href', '/server-finder')
  })
})
