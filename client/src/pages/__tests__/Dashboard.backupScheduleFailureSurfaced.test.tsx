import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// pz-ux-dashboard-deep (2026-09-18): Backups.tsx's own status card already
// reads BackupStatus.lastScheduledBackupAttempt to warn when the scheduler
// HAS been running and every attempt has been failing (bad cron target,
// unreachable backupsPath, disk full) -- lastBackup/backupCount alone stay
// silent about that, since they only ever update on a SUCCESSFUL run. The
// Dashboard's own "what needs attention" mechanism (the verdict band and the
// Backups work-item row) never read that field at all, so an operator whose
// scheduled backups had been silently failing for days saw a calm green
// dashboard and a "5 stored, last 3d ago"-looking Backups row -- exactly the
// persona-(c) gap ("does this surface a real backup-failing condition, or
// does it stay silent") this fix closes.
//
// Must fail before the fix (no verdict headline, Backups row reads only the
// stale success count) and pass after (verdict warns with a Review-backups
// action; the Backups row itself flags the failed attempt and turns 'bad').

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

// Server running, RCON connected, mods/bridge all healthy -- the ONLY
// abnormal signal is the scheduled backup attempt, so a passing verdict
// check here can only be explained by the new backup-attempt-failing case.
async function setUpFixtures() {
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
  // A healthy-looking archive (5 stored, most recent 3 days ago) -- the OLD
  // "No backups" verdict case (backupCount === 0) would never have fired
  // here, proving this is a genuinely new signal, not the pre-existing one.
  getBackupStatus.mockResolvedValue({
    lastBackup: { name: 'ashenwood-2026-09-15.zip', path: '/backups/x.zip', size: 1024, created: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() },
    backupCount: 5,
    enabled: true,
    lastScheduledBackupAttempt: {
      success: false,
      message: 'Backup destination unreachable',
      executedAt: new Date().toISOString(),
    },
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

describe('Dashboard.tsx: a failing scheduled backup attempt is surfaced, not silent', () => {
  it('the verdict band warns with a Review-backups action', async () => {
    await setUpFixtures()
    renderDashboard()

    // "Scheduled backup failing" legitimately appears twice once the fix is
    // in (the header status dot's sr-only echo, plus the verdict band's own
    // headline) -- scope to the verdict band itself rather than the whole
    // document.
    const verdict = await screen.findByRole('status', { name: 'Server verdict' })
    expect(within(verdict).getByText('Scheduled backup failing')).toBeInTheDocument()
    expect(within(verdict).getByRole('link', { name: /Review backups/ })).toHaveAttribute('href', '/backups')
  })

  it('the Backups work-item row flags the failed attempt instead of the stale success count', async () => {
    await setUpFixtures()
    renderDashboard()

    const nav = await screen.findByRole('navigation', { name: 'Server sections' })
    const backupsLink = within(nav).getByRole('link', { name: /Backups/ })
    // The old "5 stored, last 3d ago" text must NOT be what's shown while an
    // attempt since then has failed -- a stale success count would read as
    // reassuring when it no longer is.
    expect(within(backupsLink).queryByText(/stored/)).not.toBeInTheDocument()
    expect(within(backupsLink).getByText(/attempt failed/)).toBeInTheDocument()
  })
})
