import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import Dashboard from '../Dashboard'
import {
  ApiError, serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'
import * as serverStatusLib from '@/lib/serverStatus'

// A 1.5.0 support bundle: every Windows process scan failed, the server
// state read "unknown", and Start stayed disabled -- the operator could not
// start the server at all. Start is now usable; when the panel still can't
// tell (SERVER_START_STATE_UNKNOWN), it asks before starting anyway.

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

vi.mock('@/lib/serverStatus', async () => {
  const actual = await vi.importActual<typeof import('@/lib/serverStatus')>('@/lib/serverStatus')
  return { ...actual, waitForServerState: vi.fn() }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
      getPanelInfo: vi.fn(),
      getConsoleErrorCount: vi.fn(),
      start: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn(), getStatus: vi.fn() },
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

const start = vi.mocked(serverApi.start)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function setUp(provider: 'native' | 'docker-local' = 'native') {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: makeServer() })
  vi.mocked(serverApi.getStatus).mockResolvedValue({
    running: false, scanFailed: true, startTime: null, uptime: null,
    serverPath: 'C:/servers/ashenwood', serverPathConfigured: true,
    rcon: { host: '127.0.0.1', port: 27015, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
    provider, selected: true,
    host: { status: 'unknown', label: 'Process', detail: 'Process detection failed' },
    server: { status: 'disconnected', label: 'Disconnected', detail: null },
    bridge: { status: 'inactive', label: 'Inactive', detail: null },
    summary: 'unknown',
  } as Awaited<ReturnType<typeof serversApi.getComposedStatus>>)
  vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [], detectedProcesses: 0, detectionError: null })
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
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ configured: true, isRunning: false, modConnected: false })
  vi.mocked(serverStatusLib.waitForServerState).mockResolvedValue(true)
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

async function primaryStart() {
  const header = await screen.findByRole('banner', { name: /server status/i })
  // The composed "unknown" host has landed (the old code disabled Start here).
  await within(header).findByText('Status unknown')
  return within(header).getByRole('button', { name: /^start$/i })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard: Start when process detection keeps failing', () => {
  it('is enabled, and a SERVER_START_STATE_UNKNOWN refusal opens "Start anyway", which resends with ignoreUnknownState', async () => {
    setUp()
    start
      .mockRejectedValueOnce(new ApiError('cannot tell', { status: 500, code: 'SERVER_START_STATE_UNKNOWN' }))
      .mockResolvedValueOnce({ success: true })

    renderDashboard()
    await waitFor(() => expect(vi.mocked(serversApi.getComposedStatus)).toHaveBeenCalled())
    const startBtn = await primaryStart()
    await waitFor(() => expect(startBtn).not.toBeDisabled())

    fireEvent.click(startBtn)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0]).toEqual([])
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/process detection keeps failing/i)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /^start anyway$/i }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start.mock.calls[1]).toEqual([{ ignoreUnknownState: true }])
  })

  it('keeps Start disabled for an unknown host that is not this PC\'s process scan', async () => {
    setUp('docker-local')
    renderDashboard()
    await waitFor(() => expect(vi.mocked(serversApi.getComposedStatus)).toHaveBeenCalled())
    const startBtn = await primaryStart()
    await waitFor(() => expect(startBtn).toBeDisabled())
  })
})
