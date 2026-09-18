import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// pz-ux-dashboard-deep (2026-09-18): the header "Save" button's disabled=
// already accounted for !rconConnected (Save sends its command over RCON),
// but the DisabledReason wrapping it only ever explained the permission
// case -- an operator with full server.control watching the RCON line go
// red got a silently greyed-out Save button with no hover explanation at
// all, the exact "disabled control with no visible reason" irritant class
// DisabledReason exists to prevent everywhere else on this page (Wipe,
// Restart Now, Connect RCON all already get one).
//
// Must fail before the fix (no tooltip text appears on focus) and pass
// after (the wrapper explains RCON must be connected first).

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

// Server running (host process visible) but RCON is NOT connected -- exactly
// the mid-crash / RCON-down persona this whole page's verdict band already
// warns about elsewhere. canControlServer stays true throughout (useAuth's
// can() always returns true here), isolating this to the RCON condition.
async function setUpFixtures() {
  const server = makeServer()
  getResolvedActive.mockResolvedValue({ server })
  getStatus.mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 600, serverPath: 'C:/servers/ashenwood',
    serverPathConfigured: true, rcon: { host: '127.0.0.1', port: 27015, connected: false },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: true, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 3, enabled: false, lastScheduledBackupAttempt: null } as Awaited<ReturnType<typeof backupApi.getStatus>>)
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

describe('Dashboard.tsx: header Save button explains itself when disabled by RCON, not just by permission', () => {
  it('shows a tooltip naming RCON when hovered/focused while RCON is disconnected', async () => {
    await setUpFixtures()
    renderDashboard()

    const saveButton = await screen.findByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()

    // DisabledReason's actual Tooltip trigger is the focusable wrapper span
    // around the (disabled) button -- see DisabledReason.tsx.
    const wrapper = saveButton.parentElement
    expect(wrapper).not.toBeNull()
    fireEvent.focus(wrapper!)

    expect(await screen.findByText('Connect RCON to save the world.')).toBeInTheDocument()
  })
})
