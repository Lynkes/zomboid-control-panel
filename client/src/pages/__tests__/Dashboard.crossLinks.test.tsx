import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// UX restructure (2026-10): every message on the Dashboard links to the
// place its fix lives, and every row that names a page uses that page's
// sidebar label. Before: the bridge links went to bare /settings, the
// Console rows to bare /console, an online player to /players, and the
// rows said "Schedule" and "Config" where the sidebar says Scheduler and
// Configuration.

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
    serverApi: { ...actual.serverApi, getStatus: vi.fn(), getPanelInfo: vi.fn(), getConsoleErrorCount: vi.fn() },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn(), getActivityLogs: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), getZombieCount: vi.fn(), getWorldStats: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    debugApi: { ...actual.debugApi, getPerformanceHistory: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

// Running, RCON connected, a player online, PanelBridge installed but its
// mod not reporting: the verdict's top problem is "PanelBridge offline".
function setUp() {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: makeServer() })
  vi.mocked(serverApi.getStatus).mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 600, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '127.0.0.1', port: 27015, connected: true },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('no composed status in this fixture'))
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'Kate Smith', online: true }] } as never)
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: true, count: 3 })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
  vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 8 })
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 4 })
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
  vi.mocked(debugApi.getPerformanceHistory).mockResolvedValue({ history: [] })
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ configured: true, isRunning: true, modConnected: false, modStatus: null })
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard: links go to where the fix lives', () => {
  it('"PanelBridge offline" opens Settings on its PanelBridge tab', async () => {
    setUp()
    renderDashboard()

    const verdict = await screen.findByRole('status', { name: 'Server verdict' })
    expect(await within(verdict).findByText('PanelBridge offline')).toBeInTheDocument()
    expect(within(verdict).getByRole('link', { name: /Bridge settings/ })).toHaveAttribute('href', '/settings?tab=bridge')
  })

  it('an online player opens that player on Players', async () => {
    setUp()
    renderDashboard()

    const verdict = await screen.findByRole('status', { name: 'Server verdict' })
    expect(await within(verdict).findByRole('link', { name: /Kate Smith/ })).toHaveAttribute('href', '/players?player=Kate%20Smith')
  })

  it('the Console rows open the right Console tab, and every page row uses its sidebar name', async () => {
    setUp()
    renderDashboard()

    const nav = await screen.findByRole('navigation', { name: 'Server sections' })
    expect(await within(nav).findByRole('link', { name: /^Console/ })).toHaveAttribute('href', '/console?tab=rcon')
    expect(await within(nav).findByRole('link', { name: /^Errors/ })).toHaveAttribute('href', '/console?tab=log')
    expect(within(nav).getByRole('link', { name: /^Scheduler/ })).toHaveAttribute('href', '/scheduler')
    expect(within(nav).getByRole('link', { name: /^Configuration/ })).toHaveAttribute('href', '/server-config')
    expect(within(nav).queryByText('Schedule')).not.toBeInTheDocument()
    expect(within(nav).queryByText('Config')).not.toBeInTheDocument()
  })
})
