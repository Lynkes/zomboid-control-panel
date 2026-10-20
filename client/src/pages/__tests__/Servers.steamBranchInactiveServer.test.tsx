import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// The game update check reads the ACTIVE server's install, so its installed
// branch is that server's. Update / Verify on any other server used to
// preselect it anyway: a server on `public` was offered (and, with one click,
// switched to) the active server's `unstable`.

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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      steamVerify: vi.fn(),
      steamUpdate: vi.fn(),
    },
    serversDetectApi: { ...actual.serversDetectApi, detect: vi.fn(), autoScan: vi.fn() },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    serverApi: { ...actual.serverApi, detectSteamCmd: vi.fn(), getBranches: vi.fn() },
  }
})

const fakeSocket = {
  connected: true,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

const baseServer = {
  serverName: 'cfg',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
}

const ACTIVE = { ...baseServer, id: 1, name: 'active-srv', installPath: '/srv/active', zomboidDataPath: '/srv/active/data', serverConfigPath: '/srv/active/data/Server/a.ini', isActive: true }
const OTHER_PUBLIC = { ...baseServer, id: 2, name: 'other-srv', installPath: '/srv/other', zomboidDataPath: '/srv/other/data', serverConfigPath: '/srv/other/data/Server/b.ini', isActive: false }
const OTHER_IWBUMS = { ...baseServer, id: 3, name: 'beta-srv', installPath: '/srv/beta', zomboidDataPath: '/srv/beta/data', serverConfigPath: '/srv/beta/data/Server/c.ini', isActive: false, branch: 'iwbums' }

function setUpFixtures() {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [ACTIVE, OTHER_PUBLIC, OTHER_IWBUMS] } as never)
  vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] } as never)
  vi.mocked(serversApi.steamUpdate).mockResolvedValue({ success: true } as never)
  vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  vi.mocked(dockerApi.getStats).mockResolvedValue({ containers: {} } as never)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: { steamcmdPath: '/opt/steamcmd' } } as never)
  vi.mocked(configApi.updateAppSettings).mockResolvedValue({ success: true } as never)
  // The active server's install is on `unstable`.
  vi.mocked(updateApi.getStatus).mockResolvedValue({
    updateAvailable: {
      updateAvailable: false,
      installed: { branch: 'unstable', buildId: '100' },
      latest: { branch: 'unstable', buildId: '100' },
    },
    lastError: null,
  } as never)
  vi.mocked(serversDetectApi.detect).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversDetectApi.autoScan).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serverApi.detectSteamCmd).mockResolvedValue({ found: false, path: null } as never)
  vi.mocked(serverApi.getBranches).mockResolvedValue({
    branches: [
      { name: 'public', description: 'Stable' },
      { name: 'unstable', description: 'Unstable' },
    ],
  } as never)
}

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={fakeSocket}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

async function startUpdateFor(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.updateServer }))
  await screen.findByRole('heading', { name: en.steamDialog.updateTitle })
  // Let the branch lookup settle before starting.
  await waitFor(() => expect(serverApi.getBranches).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: en.steamDialog.startUpdate }))
  await waitFor(() => expect(serversApi.steamUpdate).toHaveBeenCalledTimes(1))
  return vi.mocked(serversApi.steamUpdate).mock.calls[0]
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: Update / Verify preselects the branch of the server it is for', () => {
  it('offers an inactive server with no saved branch `public`, not the active server\'s installed branch', async () => {
    setUpFixtures()
    renderServers()
    await screen.findByText('other-srv')
    await waitFor(() => expect(updateApi.getStatus).toHaveBeenCalled())

    const call = await startUpdateFor('other-srv')
    expect(call).toEqual(['/opt/steamcmd', '/srv/other', 'public'])
  })

  it('offers an inactive server its own saved branch', async () => {
    setUpFixtures()
    renderServers()
    await screen.findByText('beta-srv')
    await waitFor(() => expect(updateApi.getStatus).toHaveBeenCalled())

    const call = await startUpdateFor('beta-srv')
    expect(call).toEqual(['/opt/steamcmd', '/srv/beta', 'iwbums'])
  })

  it('still offers the active server the branch its install was built from', async () => {
    setUpFixtures()
    renderServers()
    await screen.findByText('active-srv')
    await waitFor(() => expect(updateApi.getStatus).toHaveBeenCalled())

    const call = await startUpdateFor('active-srv')
    expect(call).toEqual(['/opt/steamcmd', '/srv/active', 'unstable'])
  })
})
