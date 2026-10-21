import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'
import { MemoryRouter } from 'react-router-dom'

// SECURITY (2026-10-20, bp5): GET /servers leaves rconHost and rconPort out
// for a role holding none of servers.manage, rcon.execute and
// server.configure (server/utils/rconTargetView.js). The Console read a
// missing host or port as "RCON not configured" and put that warning, with
// an "Edit server" fix, in front of every moderator. Hidden is not unset:
// the masked password still says RCON is set up. A server with no password
// still reads as not configured.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'mod', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => ['players.view', 'players.moderate', 'players.gm_tools', 'server.world_events'].includes(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    rconApi: { ...actual.rconApi, execute: vi.fn(), getHistory: vi.fn() },
    serverApi: { ...actual.serverApi, getConsoleLog: vi.fn(), streamConsoleLog: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

function moderatorView(overrides: Partial<ServerInstance> = {}): ServerInstance {
  // No rconHost / rconPort: what GET /servers sends this role.
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '', zomboidDataPath: null,
    serverConfigPath: null, rconPassword: '••••••••',
    serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
    isRemote: true, isActive: true, startCommand: '', adminPassword: '',
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderConsole(server: ServerInstance) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
  vi.mocked(rconApi.getHistory).mockResolvedValue({ history: [] })
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <MemoryRouter><Console /></MemoryRouter>
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

describe('Console.tsx without the RCON host and port', () => {
  it('does not tell a moderator RCON is not configured', async () => {
    renderConsole(moderatorView())
    await screen.findByText(enConsole.rcon.unknown)
    expect(screen.queryByText(enConsole.rcon.notConfigured)).not.toBeInTheDocument()
    expect(screen.queryByText(enConsole.rcon.notConfiguredTitle)).not.toBeInTheDocument()
  })

  it('still says so when the server has no RCON password at all', async () => {
    renderConsole(moderatorView({ rconPassword: '' }))
    await waitFor(() => expect(screen.getByText(enConsole.rcon.notConfigured)).toBeInTheDocument())
  })
})
