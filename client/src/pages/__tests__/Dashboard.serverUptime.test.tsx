import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'
import uptimeEn from '@/locales/en/serverUptime.json'
import helpTipEn from '@/locales/en/helpTip.json'
import dashboardEn from '@/locales/en/dashboard.json'

// Community request (Discord, a Linux operator on the Direct lifecycle):
// "it would be nice if the panel showed server uptime on the dashboard".
// The header did have one -- a faint, desktop-only duration rendered only
// when the /server/status snapshot's `uptime` was > 0, which it never was
// for a server whose start time the panel couldn't establish (a systemd
// unit after a panel restart, a container). It now reads the provider-aware
// composed status's host.startedAt, counts live from it, and says "uptime
// unknown" rather than vanishing when the server is up but its start time
// isn't known.

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

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '/opt/pz',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function setUp({
  server = makeServer(),
  provider = 'native',
  hostStatus = 'running',
  hostStartedAt,
  localRunning = true,
}: {
  server?: ServerInstance
  provider?: string
  hostStatus?: string
  hostStartedAt?: string
  localRunning?: boolean
}) {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server })
  // The legacy snapshot's own uptime is deliberately absent (null): the
  // header must not depend on it any more.
  vi.mocked(serverApi.getStatus).mockResolvedValue({
    running: localRunning, startTime: null, uptime: null,
    serverPath: '/opt/pz', serverPathConfigured: true,
    rcon: { host: '127.0.0.1', port: 27015, connected: true },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
    provider,
    selected: true,
    host: {
      status: hostStatus, label: 'Process', detail: null,
      ...(hostStartedAt ? { startedAt: hostStartedAt } : {}),
    },
    server: { status: 'connected', label: 'RCON', detail: '127.0.0.1:27015' },
    bridge: { status: 'not-installed', label: 'PanelBridge', detail: null },
    summary: 'Process running, RCON connected',
  })
  vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [], detectedProcesses: 0, detectionError: null })
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: true, count: 0 })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
  vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 8 })
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [{ id: 1 }] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
  vi.mocked(debugApi.getPerformanceHistory).mockResolvedValue({ history: [] })
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({
    configured: false, isRunning: false, modConnected: false, modStatus: null,
  })
  vi.mocked(panelBridgeApi.getZombieCount).mockResolvedValue({ success: true, data: { zombieCount: 0, note: '' } })
  vi.mocked(panelBridgeApi.getWorldStats).mockResolvedValue({ success: false })
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

describe('Dashboard header: server uptime', () => {
  it('shows the uptime of a running server from the composed status start time, with the start time a tap away', async () => {
    // 5h and a few seconds: whole minutes are shown, so this reads "5h"
    // for the better part of a minute -- no fake clock needed.
    const startedAt = new Date(Date.now() - (5 * 3600 + 5) * 1000).toISOString()
    setUp({ hostStartedAt: startedAt })

    renderDashboard()

    const uptime = await screen.findByText(uptimeEn.up.replace('{{uptime}}', '5h'))
    const time = uptime.closest('time')!
    expect(time).toHaveAttribute('dateTime', startedAt)
    fireEvent.click(time)
    expect(screen.getAllByText(/^Started /).length).toBeGreaterThan(0)
  })

  it('says "uptime unknown", with a help button for the reason, for a server that is up but whose start time the panel cannot establish', async () => {
    // e.g. a process the OS didn't answer for: running, no start time.
    setUp({ hostStatus: 'running' })

    renderDashboard()

    await screen.findByText(uptimeEn.unknown)
    expect(screen.getByRole('button', { name: helpTipEn.ariaLabel.replace('{{label}}', uptimeEn.unknown) }))
      .toBeInTheDocument()
  })

  // Review: a remote SFTP server can NEVER have a start time, and its
  // REMOTE badge already says why -- "uptime unknown" there was permanent
  // noise taking the server name's room on a phone.
  it('says nothing about uptime for a remote SFTP server, which never has a start time', async () => {
    setUp({
      server: makeServer({ isRemote: true }),
      provider: 'remote-sftp',
      hostStatus: 'unknown',
      localRunning: false,
    })

    renderDashboard()

    await screen.findByText(dashboardEn.header.remoteBadge)
    expect(screen.queryByText(uptimeEn.unknown)).not.toBeInTheDocument()
    expect(screen.queryByText(/^up /)).not.toBeInTheDocument()
  })

  // Review: on a phone the always-visible uptime (shrink-0) squeezed the
  // server name -- the page's h1, naming the server Stop/Restart act on --
  // down to a few characters or nothing. jsdom has no layout, so this pins
  // the class contract that prevents it: the status light and name form one
  // group that is the only thing allowed to shrink, and the cluster around
  // it wraps, so the uptime moves to a second line instead.
  it('lets the uptime wrap below the server name instead of squeezing it', async () => {
    const startedAt = new Date(Date.now() - 3600_000).toISOString()
    setUp({ hostStartedAt: startedAt })

    renderDashboard()

    const uptime = (await screen.findByText(uptimeEn.up.replace('{{uptime}}', '1h'))).closest('time')!
    const heading = screen.getByRole('heading', { level: 1, name: 'Ashenwood' })
    const nameGroup = heading.parentElement!
    const cluster = nameGroup.parentElement!

    expect(heading).toHaveClass('min-w-0', 'truncate')
    expect(nameGroup).toHaveClass('min-w-0')
    expect(nameGroup).not.toHaveClass('flex-wrap')
    expect(nameGroup).not.toContainElement(uptime)
    expect(cluster).toHaveClass('flex-wrap')
    expect(uptime.parentElement).toBe(cluster)
    expect(uptime).not.toHaveClass('shrink-0')
  })
})
