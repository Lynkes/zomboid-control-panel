import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, updateApi, type ServerInstance,
} from '@/lib/api'

// pz-bughunt round 17 follow-up: the "perf" room is one shared broadcast --
// every client subscribed to it gets every perf:snapshot tick regardless of
// which server it's for. Jim's server-side fix tags each snapshot with the
// active server's id at the moment it was taken (mirroring
// getPerformanceHistory()'s own serverId filter in database/init.js).
// Dashboard.tsx's onSnapshot handler used to append every incoming snapshot
// unconditionally: switch the active server while the chart is showing and
// the OLD server's samples kept landing in what still looks like a live
// chart for the NEW one. Fixed to drop a snapshot whose serverId is set and
// differs from the displayed server, while still accepting one with no
// serverId at all (null/undefined -- pre-fix legacy senders, or no active
// server known), matching the server-side acceptance rule exactly.

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
    serversApi: {
      ...actual.serversApi,
      getComposedStatus: vi.fn(),
      getResolvedActive: vi.fn(),
      discoverMounts: vi.fn(),
    },
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getActivityLogs: vi.fn(),
    },
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
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
  }
})

// Stub out the real chart (recharts-backed, heavy/slow in jsdom and not
// what this test is about) -- capture exactly the performanceHistory prop
// it was given so the assertion is a direct check on Dashboard's own
// filtering logic, not on chart-rendering behavior.
vi.mock('@/components/DashboardPerformanceCharts', () => ({
  default: ({ performanceHistory }: { performanceHistory: Array<{ playerCount: number }> }) => (
    <div data-testid="perf-points">{performanceHistory.map((p) => p.playerCount).join(',')}</div>
  ),
}))

const socketHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    connected: true,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
      socketHandlers.get(event)!.add(handler)
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      socketHandlers.get(event)?.delete(handler)
    },
    emit: vi.fn(),
  }),
}))
function firePerfSnapshot(snap: Record<string, unknown>) {
  socketHandlers.get('perf:snapshot')?.forEach((h) => h(snap))
}

const getStatus = vi.mocked(serverApi.getStatus)
const getPanelInfo = vi.mocked(serverApi.getPanelInfo)
const getConsoleErrorCount = vi.mocked(serverApi.getConsoleErrorCount)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
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
const getUpdateCheckStatus = vi.mocked(updateApi.getStatus)
const discoverMounts = vi.mocked(serversApi.discoverMounts)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function setUpCommon() {
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getBridgeStatus.mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null })
  getZombieCount.mockRejectedValue(new Error('no bridge in this fixture'))
  getWorldStats.mockRejectedValue(new Error('no bridge in this fixture'))
  getUpdateCheckStatus.mockResolvedValue({
    updateAvailable: null, gameVersion: null, lastCheck: null,
    intervalMinutes: 60, isChecking: false, lastAutoUpdateResult: null,
  })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: false, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 1 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  getSchedulerTasks.mockResolvedValue({ tasks: [] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  // Seed one point so performanceHistory.length > 0 and the real chart
  // (not the "no data yet" placeholder) mounts -- see Dashboard.tsx's own
  // `{performanceHistory.length > 0 ? <DashboardPerformanceCharts/> : ...}`.
  getPerformanceHistory.mockResolvedValue({
    history: [{ timestamp: '2026-01-01T00:00:00.000Z', playerCount: 1, memoryUsed: 0 }],
  })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  discoverMounts.mockRejectedValue(new Error('not exercised by this fixture'))
  getResolvedActive.mockResolvedValue({ server: makeServer({ id: 1 }) })
  getStatus.mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 120, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '', port: 0, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Dashboard.tsx: the live perf chart drops perf:snapshot ticks for a different server', () => {
  it('appends same-server and untagged snapshots, drops a different server\'s', async () => {
    setUpCommon()

    renderDashboard()
    // Real timers, deliberately -- see Dashboard.perfChartReconnect.test.tsx's
    // own comment: the reveal effect races requestIdleCallback (timeout:
    // 1500) against a setTimeout(reveal, 300) fallback.
    await act(async () => { await sleep(1700) })

    // Seeded via getPerformanceHistory (see setUpCommon) so the real chart
    // mounts instead of the "no data yet" placeholder.
    const pointsEl = await screen.findByTestId('perf-points')
    expect(pointsEl.textContent).toBe('1')

    // Same server (id: 1, matches getResolvedActive's mock) -- appended.
    act(() => { firePerfSnapshot({ serverId: 1, playerCount: 5 }) })
    expect(pointsEl.textContent).toBe('1,5')

    // No serverId at all -- accepted per the "unknown, don't exclude" rule.
    act(() => { firePerfSnapshot({ playerCount: 7 }) })
    expect(pointsEl.textContent).toBe('1,5,7')

    // A DIFFERENT server's tagged snapshot -- dropped, not appended.
    act(() => { firePerfSnapshot({ serverId: 2, playerCount: 999 }) })
    expect(pointsEl.textContent).toBe('1,5,7')
  }, 10000)
})
