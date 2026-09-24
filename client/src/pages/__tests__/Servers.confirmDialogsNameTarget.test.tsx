import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// UX deep-pass finding (Servers page): two of this page's disruptive-action
// confirm dialogs did not name their target.
//
// 1) The inline Stop confirm (handleInlineStop) built its title/description
//    from card.stopConfirmTitle/Description with NO interpolation at all --
//    on a roster with more than one server, "Stop server?" / "This will
//    disconnect all connected players." reads identically no matter which
//    card's Stop button was clicked. Fixed by passing {{name}} through.
//
// 2) The docker-mapped card's Restart button had no confirmation step at
//    all, unlike its Stop neighbour (which already confirms because Docker
//    can end in a forced kill) -- Restart is the same "kicks connected
//    players" tier and had zero guard against a misclick. Fixed by adding an
//    analogous confirm, and its title now names the container too.
const mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
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
      activate: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
      getStats: vi.fn(),
      runAction: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    serverApi: {
      ...actual.serverApi,
      start: vi.fn(),
      stop: vi.fn(),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const activate = vi.mocked(serversApi.activate)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const dockerRunAction = vi.mocked(dockerApi.runAction)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const stop = vi.mocked(serverApi.stop)

const SERVER_A = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/server-a.ini',
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

const SERVER_B = {
  ...(SERVER_A as object),
  id: 2,
  name: 'server-b',
  serverName: 'server-b-cfg',
  installPath: '/srv/b',
  zomboidDataPath: '/srv/b/data',
  isActive: false,
  dockerContainerName: 'docker-b',
} as never

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getAll.mockResolvedValue({ servers: [SERVER_A, SERVER_B] } as never)
  getStatus.mockResolvedValue({
    servers: [{ id: 1, running: true, pid: '123', stateUnknown: false }],
  } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({
    enabled: true,
    available: true,
    containers: [{ id: 'docker-b', name: 'docker-b', image: 'zomboid', state: 'running', status: 'Up' }],
  } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockResolvedValue({} as never)
  activate.mockResolvedValue({} as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: confirm dialogs name the specific server/container they act on', () => {
  it('the inline Stop confirm names the server being stopped, not a generic "the server"', async () => {
    stop.mockResolvedValue({} as never)
    await setUpFixtures()
    renderServers()

    const stopButton = await screen.findByRole('button', { name: en.card.stop })
    fireEvent.click(stopButton)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Stop server-a?')).toBeInTheDocument()
    expect(within(dialog).getAllByText(/server-a/).length).toBeGreaterThanOrEqual(2)
  })

  it('Restart on a docker-mapped card now requires confirmation naming the container, and does nothing on Cancel', async () => {
    await setUpFixtures()
    renderServers()

    const restartButton = await screen.findByRole('button', { name: /restart docker-b/i })
    fireEvent.click(restartButton)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Restart docker-b?')).toBeInTheDocument()
    expect(dockerRunAction).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: en.deleteDialog.cancel }))
    expect(dockerRunAction).not.toHaveBeenCalled()
  })

  it('Restart actually runs once the confirm dialog is accepted', async () => {
    dockerRunAction.mockResolvedValue({ success: true } as never)
    await setUpFixtures()
    renderServers()

    const restartButton = await screen.findByRole('button', { name: /restart docker-b/i })
    fireEvent.click(restartButton)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en.card.restartContainer }))

    await screen.findByRole('button', { name: /restart docker-b/i })
    expect(dockerRunAction).toHaveBeenCalledWith('docker-b', 'restart', 2)
  })
})
