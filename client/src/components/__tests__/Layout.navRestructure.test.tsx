import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// pz-nav-menu-restructure (2026-09-18): the operator's navigation contract
// (2026-08-19) asks the sidebar to group by OBJECT -- SERVER / WORLD / USERS
// / PANEL -- instead of the old "how fresh is this" split (Live/Config/
// Maintain/Servers/Settings & Tools), and to fold Panel Users/Roles &
// Permissions/Single Sign-On (previously dropped from the sidebar entirely
// when they became Settings tabs) back in under USERS, each gated on the
// same capability that already hides its Settings tab. This file covers the
// three things a silent regression here would most likely break: (1) the
// new section grouping actually replaced the old one, (2) the three
// capability-gated entries are hidden/shown correctly and never granted a
// capability the underlying Settings tab wouldn't also grant, and (3) a nav
// row that links into a Settings ?tab= sub-page highlights as active without
// dragging the plain "Panel Settings" row along with it.

const mockCan = vi.hoisted(() => vi.fn(() => true))

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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
    },
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    modsApi: {
      ...actual.modsApi,
      getStatus: vi.fn(),
    },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serverApi.getStatus)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const modsGetStatus = vi.mocked(modsApi.getStatus)
const panelUpdateGetStatus = vi.mocked(panelUpdateApi.getStatus)

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

function mockCommonFetches() {
  updateGetStatus.mockResolvedValue({} as never)
  modsGetStatus.mockResolvedValue({ updatesAvailable: 0 } as never)
  panelUpdateGetStatus.mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })),
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mockCan.mockReturnValue(true)
})

describe('Layout.tsx: nav restructured by object (SERVER/WORLD/USERS/PANEL)', () => {
  it('renders the 4 new section labels and none of the old Live/Config/Maintain/Servers/Settings & Tools labels', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    getStatus.mockResolvedValue({ running: true } as never)
    mockCommonFetches()

    renderLayout()

    await screen.findByText('the-only-server')

    expect(screen.getByText('Server')).toBeInTheDocument()
    expect(screen.getByText('World')).toBeInTheDocument()
    expect(screen.getByText('Users')).toBeInTheDocument()
    expect(screen.getByText('Panel')).toBeInTheDocument()

    expect(screen.queryByText('Live')).not.toBeInTheDocument()
    expect(screen.queryByText('Config')).not.toBeInTheDocument()
    expect(screen.queryByText('Maintain')).not.toBeInTheDocument()
    expect(screen.queryByText('Servers')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings & Tools')).not.toBeInTheDocument()
  })

  it('every route path stays the same as before the restructure -- items only moved sections, their `to` targets did not change', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    getStatus.mockResolvedValue({ running: true } as never)
    mockCommonFetches()

    renderLayout()

    await screen.findByText('the-only-server')

    const expectedHrefs: Record<string, string> = {
      'My Servers': '/servers',
      'Server Console': '/console',
      'Server Configuration': '/server-config',
      'Mod Manager': '/mods',
      'Scheduled Tasks': '/scheduler',
      'Server Setup': '/server-setup',
      'World Map': '/world-map',
      'Events & Weather': '/events',
      'World Backups': '/backups',
      'Map Cleanup': '/chunks',
      'Templates': '/templates',
      'Online Players': '/players',
      'In-Game Chat': '/chat',
      'Panel Settings': '/settings',
      'Discord': '/discord',
      'Debug Logs': '/debug',
      'Browse Public Servers': '/server-finder',
    }
    for (const [label, href] of Object.entries(expectedHrefs)) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href)
    }
  })

  it('hides Panel Users, Roles & Permissions and Single Sign-On when the role lacks their capability, shows them (linking into the matching Settings tab) when it has it', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    getStatus.mockResolvedValue({ running: true } as never)
    mockCommonFetches()

    mockCan.mockReturnValue(false)
    const { unmount } = renderLayout()
    await screen.findByText('the-only-server')
    expect(screen.queryByRole('link', { name: 'Panel Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Roles & Permissions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Single Sign-On' })).not.toBeInTheDocument()
    unmount()

    mockCan.mockReturnValue(true)
    renderLayout()
    await screen.findByText('the-only-server')
    expect(screen.getByRole('link', { name: 'Panel Users' })).toHaveAttribute('href', '/settings?tab=users')
    expect(screen.getByRole('link', { name: 'Roles & Permissions' })).toHaveAttribute('href', '/settings?tab=roles')
    expect(screen.getByRole('link', { name: 'Single Sign-On' })).toHaveAttribute('href', '/settings?tab=sso')
  })

  it('gates each new USERS entry on the exact capability its Settings tab already requires, not on a shared/broader one', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    getStatus.mockResolvedValue({ running: true } as never)
    mockCommonFetches()

    // Only roles.manage is granted -- Panel Users (users.manage) and Single
    // Sign-On (panel.settings) must stay hidden; a shared/OR'd gate would
    // wrongly show all three once any one capability is true.
    mockCan.mockImplementation((capability: string) => capability === 'roles.manage')

    renderLayout()
    await screen.findByText('the-only-server')

    expect(screen.queryByRole('link', { name: 'Panel Users' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Roles & Permissions' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Single Sign-On' })).not.toBeInTheDocument()
  })

  it('item-level requiresServer: My Servers/Server Setup stay usable at zero servers while Server Console/Mod Manager/Scheduled Tasks (same SERVER section) show the requires-a-server disabled state', async () => {
    getAll.mockResolvedValue({ servers: [] } as never)
    mockCommonFetches()

    renderLayout()

    // "no server yet" banner is the confirmation the zero-servers path was reached
    await screen.findByText('No server yet')

    expect(screen.getByRole('link', { name: 'My Servers' })).toHaveAttribute('href', '/servers')
    expect(screen.getByRole('link', { name: 'Server Setup' })).toHaveAttribute('href', '/server-setup')

    // Disabled rows render as a plain div (aria-disabled), not a navigable link
    expect(screen.queryByRole('link', { name: 'Server Console' })).not.toBeInTheDocument()
    const disabledConsole = screen.getByText('Server Console').closest('[aria-disabled="true"]')
    expect(disabledConsole).not.toBeNull()
    expect(disabledConsole).toHaveAttribute('aria-label', expect.stringContaining('Add a server first'))
  })

  it('a ?tab= USERS entry (Panel Users) highlights as active on its own settings sub-tab without also lighting up the plain Panel Settings row', async () => {
    getAll.mockResolvedValue({ servers: [NATIVE_ACTIVE_SERVER] } as never)
    getStatus.mockResolvedValue({ running: true } as never)
    mockCommonFetches()

    renderLayout(['/settings?tab=users'])
    await screen.findByText('the-only-server')

    const panelUsersLink = screen.getByRole('link', { name: 'Panel Users' })
    const panelSettingsLink = screen.getByRole('link', { name: 'Panel Settings' })

    expect(panelUsersLink.className).toMatch(/font-medium/)
    expect(panelSettingsLink.className).not.toMatch(/font-medium/)
  })
})
