import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, type ServerInstance,
} from '@/lib/api'
import en from '../../locales/en/dashboard.json'

// SECURITY (2026-10-20, bp5): GET /server/status and GET /servers leave the
// RCON host and port out for a role holding none of servers.manage,
// rcon.execute and server.configure (server/utils/rconTargetView.js). The
// Dashboard's RCON line used to print `${host}:${port}` whenever `rcon` was
// there at all -- "undefined:undefined" for a moderator. It now says whether
// RCON is connected instead.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'mod', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => ['players.view', 'players.moderate', 'players.gm_tools', 'server.world_events'].includes(capability),
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

// What GET /servers/active sends a moderator: no rconHost / rconPort.
const SERVER = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '••••••••',
  zomboidDataPath: null, serverConfigPath: null,
  rconPassword: '••••••••', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
  useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
  adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z',
} as ServerInstance

function setUpFixtures() {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: SERVER })
  vi.mocked(serverApi.getStatus).mockResolvedValue({
    running: true, startTime: new Date().toISOString(), uptime: 600, serverPath: '••••••••',
    serverPathConfigured: true, port: 16261,
    // GET /server/status for this role: the state, no host or port.
    rcon: { connected: true },
  } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('no composed status in this fixture'))
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
  vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: true, count: 0 })
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
  vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 3, enabled: false, lastScheduledBackupAttempt: null } as Awaited<ReturnType<typeof backupApi.getStatus>>)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 12 })
  vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
  vi.mocked(debugApi.getPerformanceHistory).mockResolvedValue({ history: [] })
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({
    configured: true, isRunning: true, modConnected: true,
    modStatus: { alive: true, version: '1.7.50', serverName: 'Ashenwood', playerCount: 0 },
  })
  vi.mocked(panelBridgeApi.getZombieCount).mockResolvedValue({ success: true, data: { zombieCount: 0, note: '' } })
  vi.mocked(panelBridgeApi.getWorldStats).mockResolvedValue({ success: true, data: { serverName: 'Ashenwood', map: 'Muldraugh, KY', zombiesInCell: 0 } })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Dashboard.tsx without the RCON host and port', () => {
  it('shows the RCON line as connected, never "undefined"', async () => {
    setUpFixtures()
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Dashboard />
        </TooltipProvider>
      </MemoryRouter>,
    )
    const label = await screen.findByText(en.connLine.rcon)
    const line = label.parentElement as HTMLElement
    expect(line.textContent).toContain(en.connLine.connected)
    expect(document.body.textContent).not.toContain('undefined')
  })
})
