import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ModHealth, type ServerInstance,
} from '@/lib/api'

// Smart sort v2: when the active server's mod list has problems that stop
// mods from loading, the Dashboard's Work list gets one row for them, linking
// to the Mods page's Health view. No row without critical problems, and no
// request at all for a role without mods.manage (the route needs it).

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    serverApi: { ...actual.serverApi, getStatus: vi.fn(), getPanelInfo: vi.fn(), getConsoleErrorCount: vi.fn() },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn(), getActivityLogs: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), getZombieCount: vi.fn(), getWorldStats: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    debugApi: { ...actual.debugApi, getPerformanceHistory: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn(), getModHealth: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

const getModHealth = vi.mocked(modsApi.getModHealth)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function primeDashboard() {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: makeServer() })
  vi.mocked(serverApi.getStatus).mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 600, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '127.0.0.1', port: 27015, connected: true },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('no composed status in this fixture'))
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: true, count: 0 })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
  vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 8 })
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 108 })
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [{ id: 1 }] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
  vi.mocked(debugApi.getPerformanceHistory).mockResolvedValue({ history: [] })
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.50', serverName: 'Ashenwood', playerCount: 0 },
  })
  vi.mocked(panelBridgeApi.getZombieCount).mockResolvedValue({ success: true, data: { zombieCount: 0, note: '' } })
  vi.mocked(panelBridgeApi.getWorldStats).mockResolvedValue({ success: true, data: { serverName: 'Ashenwood', map: 'Muldraugh, KY', zombiesInCell: 0 } })
}

const health = (critical: number, warning = 0): ModHealth => ({
  checkedAt: '2026-10-20T10:00:00.000Z',
  counts: { critical, warning, info: 0 },
  issues: [],
  steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
})

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
  mockCan = () => true
})

describe('Dashboard: mod health work item', () => {
  it('adds a row linking to the Health view while critical mod problems exist', async () => {
    primeDashboard()
    getModHealth.mockResolvedValue(health(2, 4))
    renderDashboard()
    const nav = await screen.findByRole('navigation', { name: 'Server sections' })
    const row = await within(nav).findByRole('link', { name: /Mod health/ })
    expect(row).toHaveAttribute('href', '/mods?view=health')
    expect(row).toHaveTextContent('2 critical problems')
  })

  it('shows no row when the problems are only warnings', async () => {
    primeDashboard()
    getModHealth.mockResolvedValue(health(0, 3))
    renderDashboard()
    const nav = await screen.findByRole('navigation', { name: 'Server sections' })
    await waitFor(() => expect(getModHealth).toHaveBeenCalled())
    expect(within(nav).queryByRole('link', { name: /Mod health/ })).toBeNull()
  })

  it('does not ask without mods.manage', async () => {
    primeDashboard()
    mockCan = (capability) => capability !== 'mods.manage'
    getModHealth.mockResolvedValue(health(5))
    renderDashboard()
    const nav = await screen.findByRole('navigation', { name: 'Server sections' })
    await waitFor(() => expect(serversApi.getResolvedActive).toHaveBeenCalled())
    expect(getModHealth).not.toHaveBeenCalled()
    expect(within(nav).queryByRole('link', { name: /Mod health/ })).toBeNull()
  })
})
