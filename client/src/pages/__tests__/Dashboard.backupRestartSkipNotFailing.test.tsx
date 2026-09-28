import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// 2026-09-27 Discord report (server "Tavern"): the Dashboard said "Scheduled
// backup failing -- Skipped: a restart was in progress" and nothing cleared
// it. Two separate faults, both pinned here against the real Dashboard:
//
//   1. A backup a restart pushed aside was worded as a broken backup, and
//      pointed the operator at "Review backups" to hunt for a fault that
//      wasn't there. It now says what happened, with the one click that
//      clears it (Create backup), and the Backups row is a warning, not 'bad'.
//   2. A backup that succeeded AFTER a failed scheduled attempt (a manual
//      "Create backup" -- the maintainer's own advice) never cleared the
//      warning, because only Schedule History fed it. The server now reports
//      recoveredAt, and the Dashboard treats that attempt as resolved.
//
// Before the fix, test 1 shows "Scheduled backup failing" and test 2 still
// shows it too.

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

async function setUpFixtures(lastScheduledBackupAttempt: NonNullable<Awaited<ReturnType<typeof backupApi.getStatus>>['lastScheduledBackupAttempt']>) {
  const server = makeServer()
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 600, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '127.0.0.1', port: 27015, connected: true },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: true, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  // 5 stored, most recent 3 days ago -- so the "No backups" verdict can't be
  // what fires; only the scheduled-attempt state under test decides.
  getBackupStatus.mockResolvedValue({
    lastBackup: { name: 'ashenwood-2026-09-15.zip', path: '/backups/x.zip', size: 1024, created: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() },
    backupCount: 5,
    enabled: true,
    lastScheduledBackupAttempt,
  } as Awaited<ReturnType<typeof backupApi.getStatus>>)
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 12 })
  getSchedulerTasks.mockResolvedValue({ tasks: [] })
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
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard.tsx: a restart-skipped or since-recovered scheduled backup is not "failing"', () => {
  it('a backup a restart skipped says so, offers Create backup, and does not claim the backup is failing', async () => {
    await setUpFixtures({
      success: false,
      message: 'Skipped: a restart was in progress',
      executedAt: new Date().toISOString(),
      skipReason: 'restart',
      recoveredAt: null,
    })
    renderDashboard()

    const verdict = await screen.findByRole('status', { name: 'Server verdict' })
    expect(await within(verdict).findByText('Scheduled backup skipped for a restart')).toBeInTheDocument()
    expect(within(verdict).getByText(/Backups that land on a restart now wait for it to finish/)).toBeInTheDocument()
    expect(within(verdict).getByRole('button', { name: /Create backup/ })).toBeInTheDocument()
    expect(screen.queryByText('Scheduled backup failing')).not.toBeInTheDocument()

    const nav = screen.getByRole('navigation', { name: 'Server sections' })
    const backupsLink = within(nav).getByRole('link', { name: /Backups/ })
    expect(within(backupsLink).getByText(/skipped for restart/)).toBeInTheDocument()
    expect(within(backupsLink).queryByText(/attempt failed/)).not.toBeInTheDocument()
  })

  it('a failed scheduled attempt followed by a successful backup (e.g. a manual one) no longer warns', async () => {
    await setUpFixtures({
      success: false,
      message: 'Backup destination unreachable',
      executedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      skipReason: null,
      recoveredAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    })
    renderDashboard()

    const nav = await screen.findByRole('navigation', { name: 'Server sections' })
    const backupsLink = within(nav).getByRole('link', { name: /Backups/ })
    expect(await within(backupsLink).findByText(/5 stored/)).toBeInTheDocument()
    expect(within(backupsLink).queryByText(/attempt failed/)).not.toBeInTheDocument()
    expect(screen.queryByText('Scheduled backup failing')).not.toBeInTheDocument()
    expect(screen.queryByText('Scheduled backup skipped for a restart')).not.toBeInTheDocument()
  })
})
