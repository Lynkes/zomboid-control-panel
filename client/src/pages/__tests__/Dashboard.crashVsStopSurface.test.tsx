import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// bug-hunt-2026-09-18 (round 23, dashboard-crash-vs-stop-surface, moved to
// me from Pam by god): Jim's r28 describeStopReason() (1a460da9,
// server/utils/serverStatusModel.js) already distinguishes a crash from a
// deliberate stop in composedStatus.host.detail, and Servers.tsx's own
// server card already renders it via ServerStatusBadge.tsx's signal.detail
// -- but the Dashboard verdict, for a stopped server, never rendered
// anything beyond a bare "Server stopped", even though it already fetches
// composedStatus. This only adds the missing render (Verdict.detail).

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
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
      getPanelInfo: vi.fn(),
      getConsoleErrorCount: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn(), getStatus: vi.fn() },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn(), getActivityLogs: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getZombieCount: vi.fn(),
      getWorldStats: vi.fn(),
    },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    debugApi: { ...actual.debugApi, getPerformanceHistory: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

const getStatus = vi.mocked(serverApi.getStatus)
const getPanelInfo = vi.mocked(serverApi.getPanelInfo)
const getConsoleErrorCount = vi.mocked(serverApi.getConsoleErrorCount)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getBulkStatus = vi.mocked(serversApi.getStatus)
const getPlayers = vi.mocked(playersApi.getPlayers)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getZombieCount = vi.mocked(panelBridgeApi.getZombieCount)
const getWorldStats = vi.mocked(panelBridgeApi.getWorldStats)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const getModsStatus = vi.mocked(modsApi.getStatus)
const getSchedulerTasks = vi.mocked(schedulerApi.getTasks)
const getSchedulerStatus = vi.mocked(schedulerApi.getStatus)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

async function setUpStopped(hostDetail: string | null) {
  const server = makeServer()
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running: false, startTime: null, uptime: 0,
    serverPath: 'C:/servers/ashenwood', serverPathConfigured: true,
    rcon: { host: '127.0.0.1', port: 27015, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockResolvedValue({
    provider: 'native',
    selected: true,
    host: { status: 'stopped', label: 'Process', detail: hostDetail },
    server: { status: 'disconnected', label: 'RCON', detail: null },
    bridge: { status: 'not-installed', label: 'PanelBridge', detail: null },
    summary: 'Process stopped, RCON disconnected',
  } as Awaited<ReturnType<typeof serversApi.getComposedStatus>>)
  getBulkStatus.mockResolvedValue({ servers: [], detectedProcesses: 0, detectionError: null })
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: true, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 8 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 108 })
  getSchedulerTasks.mockResolvedValue({ tasks: [{ id: 1 }] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  getBridgeStatus.mockResolvedValue({
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.50', serverName: 'Ashenwood', playerCount: 0 },
  })
  getZombieCount.mockResolvedValue({ success: true, data: { zombieCount: 0, note: '' } })
  getWorldStats.mockResolvedValue({ success: true, data: { serverName: 'Ashenwood', map: 'Muldraugh, KY', zombiesInCell: 0 } })
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
        <Toaster />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard.tsx: the stopped-server verdict shows why it stopped', () => {
  it('shows the crash reason from composedStatus.host.detail', async () => {
    await setUpStopped('Crashed (exit code 1)')

    renderDashboard()
    await screen.findByText('Ashenwood')
    // Not findByText('Server stopped'): DashboardVerdict.tsx echoes the
    // verdict headline a second time in a sr-only span (for the status
    // dot's accessible name), so a plain text query matches two elements
    // and RTL's findBy* retries that as "not found yet" until it times
    // out. A direct textContent check sidesteps the ambiguity.
    await waitFor(() => {
      expect(document.body.textContent).toContain('Server stopped')
      expect(document.body.textContent).toContain('Crashed (exit code 1)')
    })
  })

  it('shows a deliberate-stop reason too, distinct from a crash', async () => {
    await setUpStopped('Stopped by an operator')

    renderDashboard()
    await screen.findByText('Ashenwood')
    await waitFor(() => {
      expect(document.body.textContent).toContain('Server stopped')
      expect(document.body.textContent).toContain('Stopped by an operator')
    })
  })
})
