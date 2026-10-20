import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'
import enErrors from '../../locales/en/errors.json'

// SECURITY (2026-10-20, access-control audit): a server's RCON host, port and
// password are server.configure's, and the per-server RCON probe answers
// servers.manage or rcon.execute only (server/routes/servers.js). The page
// follows: no probe for other roles, locked RCON fields without
// server.configure, a hint when a new host or port still carries the masked
// password, and the reconnect warning shown through its code.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'custom', capabilities: [] },
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
      update: vi.fn(),
    },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    serverApi: { ...actual.serverApi, detectSteamCmd: vi.fn(), getBranches: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const SERVER = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '••••••••',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

function setUp() {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [SERVER] } as never)
  vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] } as never)
  vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  vi.mocked(dockerApi.getStats).mockResolvedValue({ containers: {} } as never)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(serverApi.detectSteamCmd).mockResolvedValue({ found: false } as never)
  vi.mocked(serverApi.getBranches).mockResolvedValue({ branches: [] } as never)
}

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

async function openEditDialog() {
  const trigger = await screen.findByRole('button', { name: /options for server-a/i })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
  return screen.findByRole('dialog')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: RCON access control', () => {
  it('does not run the RCON probe for a role without servers.manage or rcon.execute', async () => {
    mockCan = (capability) => capability === 'players.view'
    setUp()
    renderServers()
    await screen.findByText('server-a')
    await waitFor(() => expect(serversApi.getStatus).toHaveBeenCalled())
    expect(serversApi.getRconStatuses).not.toHaveBeenCalled()
  })

  it('runs it for rcon.execute alone', async () => {
    mockCan = (capability) => capability === 'rcon.execute'
    setUp()
    renderServers()
    await waitFor(() => expect(serversApi.getRconStatuses).toHaveBeenCalled())
  })

  it('locks the RCON fields for servers.manage without server.configure', async () => {
    mockCan = (capability) => capability === 'servers.manage'
    setUp()
    renderServers()
    const dialog = await openEditDialog()
    expect(within(dialog).getByDisplayValue('127.0.0.1')).toBeDisabled()
    expect(within(dialog).getByDisplayValue('27015')).toBeDisabled()
    expect(within(dialog).getByText(en.editDialog.rconConfigureRequired)).toBeInTheDocument()
  })

  it('asks for the password again when the host or port changes and it is still the masked one', async () => {
    mockCan = () => true
    setUp()
    renderServers()
    const dialog = await openEditDialog()
    expect(within(dialog).queryByText(en.editDialog.rconPasswordReenter)).not.toBeInTheDocument()
    fireEvent.change(within(dialog).getByDisplayValue('27015'), { target: { value: '27016' } })
    expect(within(dialog).getByText(en.editDialog.rconPasswordReenter)).toBeInTheDocument()
  })

  it('shows the reconnect warning through its code', async () => {
    mockCan = () => true
    setUp()
    vi.mocked(serversApi.update).mockResolvedValue({
      server: SERVER,
      message: 'Server updated successfully',
      warnings: ['RCON could not reconnect; verify the updated connection settings'],
      warningDetails: [
        { error: 'RCON could not reconnect; verify the updated connection settings', code: 'SERVER_RCON_RECONNECT_FAILED' },
      ],
    } as never)
    renderServers()
    const dialog = await openEditDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: en.editDialog.saveChanges }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const last = toastSpy.mock.calls[toastSpy.mock.calls.length - 1][0]
    expect(String(last.description)).toContain(enErrors.SERVER_RCON_RECONNECT_FAILED)
  })
})
