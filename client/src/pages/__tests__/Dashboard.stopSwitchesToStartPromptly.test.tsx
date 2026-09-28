import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, updateApi, systemApi,
  type ComposedServerStatus, type ServerInstance,
} from '@/lib/api'

// 2026-09 Discord report (Windows native, server "MAZE"): "I stopped the
// server using the stop button and it actually stopped as expected. After
// few minutes the server was still showing as running. After a while it
// finally showed the Start button in the dashboard page." The Dashboard's
// Start/Stop branch reads `online`, which comes from composedStatus
// (host/RCON/PanelBridge) whenever it exists -- but neither the live
// server:status push nor the page's own confirmed Stop refetched it, so the
// pre-stop answer stayed on screen until the 15s poll (and, before the
// server-side fix, for as long as an exited server's PanelBridge heartbeat
// still read as live).

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
      stop: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getComposedStatus: vi.fn(),
      getResolvedActive: vi.fn(),
      getStatus: vi.fn(),
      discoverMounts: vi.fn(),
    },
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
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    systemApi: { ...actual.systemApi, getRuntime: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

// Stable-identity fake socket (see Dashboard.activeServerRaceOrder.test.tsx).
const socketHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))

const getStatus = vi.mocked(serverApi.getStatus)
const stop = vi.mocked(serverApi.stop)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getBulkStatus = vi.mocked(serversApi.getStatus)

const RUNNING: ComposedServerStatus = {
  provider: 'native',
  selected: true,
  host: { status: 'running', label: 'Process', detail: null },
  server: { status: 'connected', label: 'RCON', detail: '127.0.0.1:27015' },
  bridge: { status: 'active', label: 'PanelBridge', detail: null },
  summary: 'Process running, RCON connected',
}

const STOPPED: ComposedServerStatus = {
  provider: 'native',
  selected: true,
  host: { status: 'stopped', label: 'Process', detail: 'Stopped by an operator' },
  server: { status: 'disconnected', label: 'RCON', detail: '127.0.0.1:27015' },
  bridge: { status: 'offline', label: 'PanelBridge', detail: null },
  summary: 'Process stopped, RCON disconnected',
}

function setServerState(running: boolean) {
  getStatus.mockResolvedValue({
    running, startTime: running ? new Date().toISOString() : null, uptime: running ? 600 : 0,
    serverPath: 'C:/PZServer', serverPathConfigured: true,
    rcon: { host: '127.0.0.1', port: 27015, connected: running },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockResolvedValue(running ? RUNNING : STOPPED)
  getBulkStatus.mockResolvedValue({
    servers: [{ id: '1', name: 'MAZE', running, pid: running ? '4242' : null, isActive: true, stateUnknown: false }],
    detectedProcesses: running ? 1 : 0,
    detectionError: null,
  })
}

function setUp() {
  const server: ServerInstance = {
    id: 1, name: 'MAZE', serverName: 'MAZE', installPath: 'C:/PZServer',
    zomboidDataPath: 'C:/PZServer_Data', serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z',
  }
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server })
  setServerState(true)
  vi.mocked(serversApi.discoverMounts).mockRejectedValue(new Error('not exercised by this fixture'))
  vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: true, count: 0 })
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
  vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 8 })
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
  vi.mocked(debugApi.getPerformanceHistory).mockResolvedValue({ history: [] })
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  vi.mocked(updateApi.getStatus).mockRejectedValue(new Error('not exercised by this fixture'))
  vi.mocked(systemApi.getRuntime).mockRejectedValue(new Error('not exercised by this fixture'))
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.60', serverName: 'MAZE', playerCount: 0 },
  })
  vi.mocked(panelBridgeApi.getZombieCount).mockResolvedValue({ success: false })
  vi.mocked(panelBridgeApi.getWorldStats).mockResolvedValue({ success: false })
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

async function statusHeader() {
  return screen.findByRole('banner', { name: /server status/i })
}

// Well under the page's own 15s poll: a switch that only lands via that poll
// must fail these, not pass slowly.
const PROMPT = { timeout: 3000 }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Dashboard.tsx: Start replaces Stop within seconds of the server stopping', () => {
  it('refetches the composed status on the live server:status push', async () => {
    setUp()
    renderDashboard()
    await within(await statusHeader()).findByRole('button', { name: /^stop$/i }, PROMPT)

    setServerState(false)
    await act(async () => {
      socketHandlers.get('server:status')?.forEach((handler) => handler({ running: false, phase: 'stopped' }))
    })

    await within(await statusHeader()).findByRole('button', { name: /^start$/i }, PROMPT)
    expect(within(await statusHeader()).queryByRole('button', { name: /^stop$/i })).toBeNull()
    // The verdict says the same thing as the button, with the reason.
    await waitFor(() => {
      expect(document.body.textContent).toContain('Server stopped')
      expect(document.body.textContent).toContain('Stopped by an operator')
    })
  })

  it('refetches the composed status once its own Stop is confirmed, with no push at all', async () => {
    setUp()
    stop.mockResolvedValue({ success: true, confirmed: false } as never)
    renderDashboard()
    fireEvent.click(await within(await statusHeader()).findByRole('button', { name: /^stop$/i }, PROMPT))
    const confirmStop = await screen.findByRole('button', { name: 'Stop server', hidden: true })

    // The process exits: the confirmation poll, the plain status and a fresh
    // composed status all say stopped from here on.
    setServerState(false)
    fireEvent.click(confirmStop)

    await waitFor(() => expect(stop).toHaveBeenCalled())
    await within(await statusHeader()).findByRole('button', { name: /^start$/i }, PROMPT)
  })
})
