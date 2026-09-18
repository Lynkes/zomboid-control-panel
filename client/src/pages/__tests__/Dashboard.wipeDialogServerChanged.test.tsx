import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'

// pz-bughunt round 17 (every write that trusts the server-side active
// server): serverApi.wipePreview()/wipe() both resolve "the active server"
// server-side with no server id in the request -- the same shape as
// Mods.tsx's saveModOrder() (see Mods.tsx's own serverChangedSinceLoad and
// bug-hunt-2026-09-04/05). The wipe dialog's Preview step shows file counts
// for whichever server was active when Preview was clicked; before this
// fix, nothing stopped the operator from then switching the active server
// (another tab/operator) while the dialog stayed open, and clicking "Wipe
// Now" would silently delete the NEW active server's saves using targets
// chosen against the OLD server's preview -- worse than the mod load-order
// case, since this is destructive and (without a backup) irreversible.

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
      wipePreview: vi.fn(),
      wipe: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn(), discoverMounts: vi.fn() },
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

// Stable-identity fake socket -- same as Dashboard.activeServerRaceOrder.
// test.tsx: a fresh object literal per useSocket() call would thrash the
// activeServerChanged effect on every render.
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
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getStatus = vi.mocked(serverApi.getStatus)
const getPanelInfo = vi.mocked(serverApi.getPanelInfo)
const getConsoleErrorCount = vi.mocked(serverApi.getConsoleErrorCount)
const wipePreview = vi.mocked(serverApi.wipePreview)
const wipe = vi.mocked(serverApi.wipe)
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

const offlineStatus = {
  running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
  serverPathConfigured: true, rcon: { host: '', port: 0, connected: false },
} as Awaited<ReturnType<typeof serverApi.getStatus>>

function setUpCommon() {
  getComposedStatus.mockRejectedValue(new Error('no composed status in this fixture'))
  getPlayers.mockResolvedValue({ players: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getPanelInfo.mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  getConsoleErrorCount.mockResolvedValue({ exists: false, count: 0 })
  getAppSettings.mockResolvedValue({ settings: {} })
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 1 })
  getModsStatus.mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
  getSchedulerTasks.mockResolvedValue({ tasks: [] })
  getSchedulerStatus.mockResolvedValue({ nextRun: null })
  getPerformanceHistory.mockResolvedValue({ history: [] })
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  getBridgeStatus.mockResolvedValue({ configured: true, isRunning: true, modConnected: false, modStatus: null })
  getZombieCount.mockResolvedValue({ success: false })
  getWorldStats.mockResolvedValue({ success: false })
  discoverMounts.mockRejectedValue(new Error('not exercised by this fixture'))
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

async function openMoreActionsMenu() {
  // Radix's DropdownMenuTrigger opens on pointerdown, not click.
  const trigger = await screen.findByRole('button', { name: /more server actions/i })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Dashboard.tsx: the Wipe dialog is blocked once the active server changes underneath it', () => {
  it('disables Wipe Now (and Preview) and never calls serverApi.wipe after activeServerChanged fires with the dialog open', async () => {
    setUpCommon()
    const server = makeServer()
    getResolvedActive.mockResolvedValue({ server })
    getStatus.mockResolvedValue(offlineStatus)
    wipePreview.mockResolvedValue({ totalFiles: 5, totalSize: 1024, preview: {} })
    wipe.mockResolvedValue({ success: true, backupCreated: false, backupName: null })

    renderDashboard()
    await screen.findByText('Ashenwood')

    const menu = await openMoreActionsMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /wipe server/i }))
    const dialog = await screen.findByRole('alertdialog')

    // Preview against the server active right now (Ashenwood).
    fireEvent.click(within(dialog).getByRole('button', { name: /^preview$/i }))
    const wipeNowButton = await within(dialog).findByRole('button', { name: /wipe now/i })
    expect(wipeNowButton).not.toBeDisabled()
    expect(wipePreview).toHaveBeenCalledTimes(1)

    // The active server changes elsewhere while the dialog is still open,
    // preview still showing Ashenwood's 5 files.
    await act(async () => { emitActiveServerChanged() })

    // Wipe Now is now blocked (Preview already succeeded, so its button is
    // replaced by Wipe Now in this flow -- see the dialog's own ternary),
    // and a warning explains why.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /wipe now/i })).toBeDisabled())
    expect(within(dialog).getByText(/active server changed/i)).toBeInTheDocument()

    // The bug: clicking Wipe Now must not reach the API -- it would delete
    // whichever server is active NOW using Ashenwood's stale preview.
    fireEvent.click(within(dialog).getByRole('button', { name: /wipe now/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wipe).not.toHaveBeenCalled()

    // Cancelling and reopening clears the guard for a fresh preview.
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })
})
