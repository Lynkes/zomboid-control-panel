import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, updateApi, systemApi, type ServerInstance,
} from '@/lib/api'

// bug-hunt-2026-09-18 (round 9, activeServerChanged race sweep): fetchStatus
// runs both on the 15s poll and on activeServerChanged (onActiveServer),
// with no guard against the two overlapping -- a poll tick for the server
// that was active a moment ago, still in flight, could resolve AFTER the
// activeServerChanged-triggered call for the NEW server and silently
// overwrite it, with no further trigger to self-correct. Same shape as
// Console.tsx's own fix (Console.activeServerRaceOrder.test.tsx), pulled out
// into the shared useRequestGuard hook once a third+ page needed it.

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
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn(), getResolvedActive: vi.fn(), discoverMounts: vi.fn() },
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
    // Two DIFFERENT namespaces both expose a `getStatus` -- panelUpdateApi is
    // the panel's own self-update checker, updateApi is the game/server
    // update checker (server/update-check/status). A component this page
    // renders calls the latter directly; missing it here let a REAL,
    // unmocked fetch through, which (retries defaulting on, unlike
    // systemApi.getRuntime's deliberate retries=0) cost real backoff time
    // and made this file's own race test time out at 60s -- found by
    // temporarily stubbing globalThis.fetch and asserting no calls reached
    // it, not by inspection.
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    systemApi: { ...actual.systemApi, getRuntime: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: { ...actual.schedulerApi, getTasks: vi.fn(), getStatus: vi.fn() },
  }
})

// Same stable-identity fake socket as Console.activeServerRaceOrder.test.tsx
// -- must not be a fresh object literal per useSocket() call, or every
// render would re-run this page's activeServerChanged effect.
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
const getUpdateCheckStatus = vi.mocked(updateApi.getStatus)
const getRuntime = vi.mocked(systemApi.getRuntime)

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
  const server = makeServer()
  getResolvedActive.mockResolvedValue({ server })
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
  getUpdateCheckStatus.mockRejectedValue(new Error('not exercised by this fixture'))
  getRuntime.mockRejectedValue(new Error('not exercised by this fixture'))
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
  socketHandlers.clear()
})

const statusOf = (running: boolean): Awaited<ReturnType<typeof serverApi.getStatus>> => ({
  running, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
  serverPathConfigured: true, rcon: { host: '', port: 0, connected: false },
})

// "offline" and "idle" are not unique strings on this page (the sidebar's
// Players/RCON rows also say "offline"), so every check below is scoped to
// the Live Activity panel specifically: find its heading, then read the
// status span inside that same <header>.
function liveActivityStatus(): HTMLElement {
  const heading = screen.getByText('Live activity')
  const header = heading.closest('header')
  if (!header) throw new Error('Live activity heading has no <header> ancestor')
  return within(header).getByText(/^(idle|offline)$/)
}

describe('Dashboard.tsx: an older, slower status response must not overwrite a newer one', () => {
  it('keeps the newer server status when an earlier in-flight fetch resolves AFTER the activeServerChanged fetch', async () => {
    setUpCommon()

    // Call #1 (mount): resolves normally and fast, server not running --
    // Dashboard gates its whole content behind this settling (initialLoading),
    // so it must NOT be the one held open, or the page never finishes its
    // first render at all.
    getStatus.mockResolvedValueOnce(statusOf(false))
    renderDashboard()
    // activeServer itself loads via a separate, un-awaited batch
    // (fetchActiveServer, fired after the first bootstrap batch settles) --
    // wait for the server's own name first so hasServer is confirmed true
    // before relying on any `online`-derived text next to it.
    await screen.findByText('Ashenwood')
    await waitFor(() => expect(liveActivityStatus()).toHaveTextContent('offline'))
    expect(getStatus).toHaveBeenCalledTimes(1)

    // Call #2 (a later poll tick, simulated here via the page's own 'r'
    // refresh shortcut so the test doesn't need fake timers): held open --
    // stands in for a slow/delayed response for whichever server was active
    // when it was issued.
    let resolveStalePoll: (value: Awaited<ReturnType<typeof serverApi.getStatus>>) => void = () => {}
    const stalePoll = new Promise<Awaited<ReturnType<typeof serverApi.getStatus>>>((resolve) => { resolveStalePoll = resolve })
    getStatus.mockImplementationOnce(() => stalePoll)
    await act(async () => { fireEvent.keyDown(window, { key: 'r' }) })
    expect(getStatus).toHaveBeenCalledTimes(2)

    // Call #3 (activeServerChanged): resolves immediately with the server
    // now running -- "idle" is the observable signal (Live Activity header,
    // no player events yet) that this landed.
    getStatus.mockImplementationOnce(() => Promise.resolve(statusOf(true)))
    await act(async () => { emitActiveServerChanged() })
    expect(getStatus).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(liveActivityStatus()).toHaveTextContent('idle'))

    // The stale call #2 finally lands, arriving strictly after call #3's
    // already-applied, newer response.
    await act(async () => { resolveStalePoll(statusOf(false)) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently reverts the Live Activity header back to "offline" even
    // though the server is confirmed running by the newer response. Give
    // the (buggy) late apply a tick to land before asserting the negative.
    await act(async () => { await Promise.resolve() })
    expect(liveActivityStatus()).toHaveTextContent('idle')
  })
})
