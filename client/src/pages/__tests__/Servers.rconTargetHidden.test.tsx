import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// SECURITY (2026-10-20, bp5): GET /servers leaves rconHost and rconPort out
// for a role holding none of servers.manage, rcon.execute and
// server.configure (server/utils/rconTargetView.js). The page must read
// them as hidden: no "undefined:undefined" RCON fact on the card, and the
// read-only edit dialog neither shows "undefined" nor asks for the RCON
// password again.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'mod', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => ['players.view', 'players.moderate', 'server.world_events'].includes(capability),
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

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

// What GET /servers sends a moderator: host folders masked, no RCON target.
const SERVER = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '••••••••',
  zomboidDataPath: '••••••••',
  serverConfigPath: null,
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx without the RCON host and port', () => {
  it('renders the card without an RCON fact', async () => {
    setUp()
    renderServers()
    await screen.findByText('server-a')
    expect(screen.queryByText(en.card.rcon)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('undefined')
    // The card's other facts are still there.
    expect(screen.getByText(en.card.gamePort)).toBeInTheDocument()
  })

  it('opens the read-only edit dialog without "undefined" or a password re-entry hint', async () => {
    setUp()
    renderServers()
    const trigger = await screen.findByRole('button', { name: /options for server-a/i })
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.edit }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toContain('undefined')
    for (const input of within(dialog).getAllByRole('textbox')) {
      expect((input as HTMLInputElement).value).not.toBe('undefined')
    }
    expect(within(dialog).queryByText(en.editDialog.rconPasswordReenter)).not.toBeInTheDocument()
    expect(within(dialog).getByText(en.editDialog.rconConfigureRequired)).toBeInTheDocument()
  })
})
