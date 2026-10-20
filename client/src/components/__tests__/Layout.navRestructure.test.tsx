import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// UX restructure (2026-10-20, plan §2.1): the sidebar is built from the
// route registry (lib/navigation.ts) as SERVER (the active server's daily
// work) / PLAYERS / WORLD / PANEL, with one short name per page. Add a
// Server left the sidebar (Servers stays lit on it); Public Servers is the
// last PANEL row; Panel Users, Roles & Permissions and Single Sign-On stay
// Settings tabs. Capability, no-server and remote gates are unchanged.

const mockCan = vi.hoisted(() => vi.fn((_capability: string) => true))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: false,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: mockCan,
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

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serverApi.getStatus)

const NATIVE_ACTIVE_SERVER = {
  id: 1,
  name: 'the-only-server',
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

function renderLayout(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SocketContext.Provider value={null}>
        <Layout>
          <div>page content</div>
        </Layout>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function mockCommonFetches(servers: unknown[] = [NATIVE_ACTIVE_SERVER]) {
  getAll.mockResolvedValue({ servers } as never)
  getStatus.mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main navigation' })
const navLinks = () => within(mainNav()).getAllByRole('link')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mockCan.mockImplementation(() => true)
})

describe('Layout.tsx: sidebar from the route registry', () => {
  it('groups rows under SERVER / PLAYERS / WORLD / PANEL ("Users" is gone)', async () => {
    mockCommonFetches()
    renderLayout()
    await screen.findByText('the-only-server')
    const lanes = [...mainNav().querySelectorAll('.label-micro')].map((el) => el.textContent)
    expect(lanes).toEqual(['Server', 'Players', 'World', 'Panel'])
  })

  it('lists each page once, by its short name, in the new order, with unchanged routes', async () => {
    mockCommonFetches()
    renderLayout()
    await screen.findByText('the-only-server')
    const rows = navLinks().map((link) => [link.textContent?.trim(), link.getAttribute('href')])
    expect(rows).toEqual([
      ['Dashboard', '/'],
      ['Console', '/console'],
      ['Configuration', '/server-config'],
      ['Mods', '/mods'],
      ['Files', '/files'],
      ['Templates', '/templates'],
      ['Scheduler', '/scheduler'],
      ['Players', '/players'],
      ['Chat', '/chat'],
      ['Leaderboard', '/leaderboard'],
      ['World Map', '/world-map'],
      ['Events & Weather', '/events'],
      ['Backups', '/backups'],
      ['Map Cleanup', '/chunks'],
      ['Servers', '/servers'],
      ['Discord', '/discord'],
      ['Settings', '/settings'],
      ['Diagnostics', '/debug'],
      ['Public Servers', '/server-finder'],
    ])
  })

  it('has no Add a Server row, and lights Servers while adding one', async () => {
    mockCommonFetches()
    renderLayout(['/server-setup'])
    await screen.findByText('the-only-server')
    expect(within(mainNav()).queryByRole('link', { name: /Add a Server/ })).not.toBeInTheDocument()
    expect(within(mainNav()).getByRole('link', { name: 'Servers' })).toHaveAttribute('aria-current', 'page')
  })

  it('lights only the current page\'s row', async () => {
    mockCommonFetches()
    renderLayout(['/server-finder'])
    await screen.findByText('the-only-server')
    const current = navLinks().filter((link) => link.getAttribute('aria-current') === 'page')
    expect(current.map((link) => link.textContent)).toEqual(['Public Servers'])
  })

  it('at zero servers: panel rows stay usable, server rows are inert with the reason, and the banner offers "Add a server"', async () => {
    mockCommonFetches([])
    renderLayout()
    await screen.findByText('No server yet')

    expect(within(mainNav()).getByRole('link', { name: 'Servers' })).toHaveAttribute('href', '/servers')
    expect(within(mainNav()).getByRole('link', { name: 'Public Servers' })).toHaveAttribute('href', '/server-finder')
    expect(within(mainNav()).queryByRole('link', { name: 'Console' })).not.toBeInTheDocument()
    const disabledConsole = within(mainNav()).getByText('Console').closest('[aria-disabled="true"]')
    expect(disabledConsole).toHaveAttribute('aria-label', expect.stringContaining('Add a server first'))
    expect(screen.getByRole('link', { name: 'Add a server' })).toHaveAttribute('href', '/server-setup')
  })

  it('Panel Users, Roles & Permissions and Single Sign-On have no sidebar entry, and Settings stays lit on those tabs', async () => {
    mockCommonFetches()
    renderLayout(['/settings?tab=users'])
    await screen.findByText('the-only-server')
    for (const name of ['Panel Users', 'Users', 'Roles & Permissions', 'Single Sign-On']) {
      expect(within(mainNav()).queryByRole('link', { name })).not.toBeInTheDocument()
    }
    expect(within(mainNav()).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    const hrefs = navLinks().map((el) => el.getAttribute('href') ?? '')
    expect(hrefs.filter((href) => /^\/settings\?tab=/.test(href))).toEqual([])
  })

  it('hides Files without files.manage, and shows it with it', async () => {
    mockCommonFetches()
    mockCan.mockImplementation((capability: string) => capability !== 'files.manage')
    const { unmount } = renderLayout()
    await screen.findByText('the-only-server')
    expect(within(mainNav()).queryByText('Files')).not.toBeInTheDocument()
    unmount()

    mockCan.mockImplementation((capability: string) => capability === 'files.manage')
    renderLayout()
    await screen.findByText('the-only-server')
    expect(within(mainNav()).getByRole('link', { name: 'Files' })).toHaveAttribute('href', '/files')
  })

  it('on a remote server: Files stays (SFTP), local-only rows are inert with the reason, Configuration needs its mirror', async () => {
    mockCommonFetches([{ ...(NATIVE_ACTIVE_SERVER as object), isRemote: true }])
    const { unmount } = renderLayout()
    await screen.findByText('the-only-server')
    expect(within(mainNav()).getByRole('link', { name: 'Files' })).toHaveAttribute('href', '/files')
    expect(within(mainNav()).queryByRole('link', { name: 'Mods' })).not.toBeInTheDocument()
    expect(within(mainNav()).getByText('Mods').closest('[aria-disabled="true"]'))
      .toHaveAttribute('aria-label', expect.stringContaining('Not available for remote'))
    expect(within(mainNav()).queryByRole('link', { name: 'Configuration' })).not.toBeInTheDocument()
    unmount()

    mockCommonFetches([{ ...(NATIVE_ACTIVE_SERVER as object), isRemote: true, remoteConfigConfigured: true }])
    renderLayout()
    await screen.findByText('the-only-server')
    expect(within(mainNav()).getByRole('link', { name: 'Configuration' })).toHaveAttribute('href', '/server-config')
    expect(within(mainNav()).queryByRole('link', { name: 'Backups' })).not.toBeInTheDocument()
  })
})
