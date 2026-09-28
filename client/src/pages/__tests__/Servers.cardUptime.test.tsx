import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'
import uptimeEn from '@/locales/en/serverUptime.json'

// The Managed Servers cards show each running server's uptime next to its
// status badge, from the same sources as the badge itself: the selected
// server's composed status, and every other card's own row of the
// per-server list (GET /api/servers/status now carries startedAt). A card
// with no known start time shows nothing -- never "up 0s".

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
      getComposedStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
    },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
  }
})

const BASE = {
  zomboidDataPath: null,
  serverConfigPath: null,
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
const ACTIVE = { ...BASE, id: 1, name: 'active-server', serverName: 'a-cfg', installPath: '/srv/a', isActive: true } as never
const RUNNING = { ...BASE, id: 2, name: 'other-running-server', serverName: 'b-cfg', installPath: '/srv/b', isActive: false } as never
const STOPPED = { ...BASE, id: 3, name: 'other-stopped-server', serverName: 'c-cfg', installPath: '/srv/c', isActive: false } as never

// Whole minutes are shown, so "Nh" holds for most of a minute: a few
// seconds past the hour keeps these stable without a fake clock.
const hoursAgo = (hours: number) => new Date(Date.now() - (hours * 3600 + 5) * 1000).toISOString()

function cardFor(serverName: string): HTMLElement {
  const card = screen.getByText(serverName).closest('.overflow-hidden.transition-colors')
  if (!card) throw new Error(`could not find card container for ${serverName}`)
  return card as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: server cards show uptime', () => {
  it('shows the selected server\'s uptime from its composed status and every other running card\'s from its own row', async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [ACTIVE, RUNNING, STOPPED] } as never)
    vi.mocked(serversApi.getStatus).mockResolvedValue({
      servers: [
        { id: 1, running: true, pid: '111', isActive: true, startedAt: hoursAgo(9) },
        { id: 2, running: true, pid: '222', isActive: false, startedAt: hoursAgo(2) },
        { id: 3, running: false, pid: null, isActive: false, startedAt: null },
      ],
    } as never)
    vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
      provider: 'native',
      selected: true,
      host: { status: 'running', label: 'Process', detail: null, startedAt: hoursAgo(5) },
      server: { status: 'connected', label: 'RCON', detail: null },
      bridge: { status: 'not-installed', label: 'PanelBridge', detail: null },
      summary: 'Process running, RCON connected',
    })
    vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] } as never)
    vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] } as never)
    vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
    vi.mocked(dockerApi.getStats).mockResolvedValue({ containers: {} } as never)
    vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as never)
    vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)

    render(
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
    await screen.findByText('other-stopped-server')

    const up = (uptime: string) => uptimeEn.up.replace('{{uptime}}', uptime)
    await waitFor(() => {
      // The composed status wins for the selected card -- not its list row.
      expect(cardFor('active-server').textContent).toContain(up('5h'))
      expect(cardFor('other-running-server').textContent).toContain(up('2h'))
    })
    expect(cardFor('active-server').textContent).not.toContain(up('9h'))
    expect(cardFor('other-stopped-server').textContent).not.toMatch(/\bup \d/)
    expect(cardFor('other-stopped-server').textContent).not.toContain(uptimeEn.unknown)
  })
})
