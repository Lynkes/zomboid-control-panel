import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, updateApi, type ServerInstance,
} from '@/lib/api'

// Console audit (2026-10-12): after the operator switched the active server,
// the Dashboard kept the previous server's performance history. The telemetry
// rows read the LAST sample, so they showed the old server's memory, CPU and
// players until the next 60 s tick appended one for the new server (the
// history was only ever fetched when the charts first appeared). The history
// is now dropped on activeServerChanged and fetched again, and a fetch still
// in flight for the old server is discarded.

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

// The real chart is recharts-backed and heavy in jsdom; expose the points it
// was handed (their player counts) instead.
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
function fireActiveServerChanged(payload: unknown) {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h(payload))
}

const getPerformanceHistory = vi.mocked(debugApi.getPerformanceHistory)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function history(playerCount: number) {
  return { history: [{ timestamp: '2026-01-01T00:00:00.000Z', playerCount, memoryUsed: 0 }] }
}

function setUpCommon() {
  vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('no composed status in this fixture'))
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null })
  vi.mocked(panelBridgeApi.getZombieCount).mockRejectedValue(new Error('no bridge in this fixture'))
  vi.mocked(panelBridgeApi.getWorldStats).mockRejectedValue(new Error('no bridge in this fixture'))
  vi.mocked(updateApi.getStatus).mockResolvedValue({
    updateAvailable: null, gameVersion: null, lastCheck: null,
    intervalMinutes: 60, isChecking: false, lastAutoUpdateResult: null,
  })
  vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: false, count: 0 })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
  vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 1 })
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  vi.mocked(serversApi.discoverMounts).mockRejectedValue(new Error('not exercised by this fixture'))
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: makeServer({ id: 1 }) })
  vi.mocked(serverApi.getStatus).mockResolvedValue({
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Dashboard.tsx: the performance history follows the active server', () => {
  it('drops the previous server\'s samples at once and shows the new server\'s history when it arrives', async () => {
    setUpCommon()
    getPerformanceHistory.mockResolvedValue(history(1))

    renderDashboard()
    // Real timers: the charts are revealed by requestIdleCallback (timeout
    // 1500) or a 300 ms fallback -- see Dashboard.perfSnapshotServerFilter.
    await act(async () => { await sleep(1700) })
    expect((await screen.findByTestId('perf-points')).textContent).toBe('1')

    let resolveNew: (value: ReturnType<typeof history>) => void = () => {}
    getPerformanceHistory.mockImplementationOnce(
      () => new Promise((resolve) => { resolveNew = resolve as typeof resolveNew }) as never,
    )
    act(() => { fireActiveServerChanged({ server: makeServer({ id: 2, name: 'Birchwood' }) }) })

    // Not the old server's last sample while the new history is on its way.
    await waitFor(() => expect(screen.queryByTestId('perf-points')).not.toBeInTheDocument())
    await waitFor(() => expect(getPerformanceHistory).toHaveBeenCalledTimes(2))

    await act(async () => { resolveNew(history(9)) })
    expect((await screen.findByTestId('perf-points')).textContent).toBe('9')
  }, 15000)

  it('ignores a history response for the old server that lands after the switch', async () => {
    setUpCommon()
    let resolveOld: (value: ReturnType<typeof history>) => void = () => {}
    getPerformanceHistory.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOld = resolve as typeof resolveOld }) as never,
    )

    renderDashboard()
    await act(async () => { await sleep(1700) })
    await waitFor(() => expect(getPerformanceHistory).toHaveBeenCalledTimes(1))

    getPerformanceHistory.mockResolvedValue(history(9))
    act(() => { fireActiveServerChanged({ server: makeServer({ id: 2, name: 'Birchwood' }) }) })
    expect((await screen.findByTestId('perf-points')).textContent).toBe('9')

    // The first server's answer finally arrives.
    await act(async () => { resolveOld(history(1)) })
    expect(screen.getByTestId('perf-points').textContent).toBe('9')
  }, 15000)
})
