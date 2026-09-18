import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import {
  configApi, serverApi, serversApi, panelBridgeApi, backupApi, authApi,
  panelUpdateApi, modsApi, systemApi, type ServerInstance,
} from '@/lib/api'

// bug-hunt-2026-09-18 (round 10, activeServerChanged race sweep continued):
// fetchServers runs both on mount and on activeServerChanged, with no guard
// against the two overlapping -- a slow mount call, still in flight, could
// resolve AFTER the activeServerChanged-triggered call for the NEW server
// and silently overwrite it. Same shape as Dashboard's fetchStatus fix
// (Dashboard.activeServerRaceOrder.test.tsx), reusing the shared
// useRequestGuard hook via `serversGuard`.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    // false so the raw `fetch("/api/auth/reset-status")` local-password-reset
    // probe (Settings.tsx, gated on authEnabled) never fires -- it's the one
    // call on this page that bypasses lib/api.ts entirely, so it can't be
    // covered by the @/lib/api mock below.
    authEnabled: false,
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
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), getCorsDiagnostics: vi.fn() },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn(), listBackups: vi.fn() },
    authApi: { ...actual.authApi, getRecoveryCodes: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, collectionBrowsers: vi.fn() },
    systemApi: { ...actual.systemApi, getRuntime: vi.fn() },
  }
})

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

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)
const getAll = vi.mocked(serversApi.getAll)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getBackupStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getRecoveryCodes = vi.mocked(authApi.getRecoveryCodes)
const getPanelUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const collectionBrowsers = vi.mocked(modsApi.collectionBrowsers)
const getRuntime = vi.mocked(systemApi.getRuntime)

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '10.0.0.5', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function setUpCommon() {
  getAppSettings.mockResolvedValue({ settings: {} })
  getCorsDiagnostics.mockResolvedValue({
    diagnostics: {
      allowAll: false, allowPrivateNetworks: false, debug: false, customOrigins: [],
      effectiveAllowedOrigins: [], blocked: [], blockedCount: 0, lastLoadedAt: null,
    },
  })
  getNetworkInterfaces.mockResolvedValue({ interfaces: [] })
  getBridgeStatus.mockRejectedValue(new Error('not exercised by this fixture'))
  getBackupStatus.mockResolvedValue({ lastBackup: null, backupCount: 0, schedule: '0 */6 * * *', maxBackups: 10, enabled: true })
  listBackups.mockResolvedValue({ backups: [] })
  getRecoveryCodes.mockRejectedValue(new Error('not exercised by this fixture'))
  getPanelUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
    releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
    downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
  })
  collectionBrowsers.mockRejectedValue(new Error('not exercised by this fixture'))
  getRuntime.mockRejectedValue(new Error('not exercised by this fixture'))
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=bridge']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Settings.tsx: an older, slower server-list response must not overwrite a newer one', () => {
  it('keeps the newer active server when an earlier in-flight fetchServers call resolves AFTER the activeServerChanged fetch', async () => {
    setUpCommon()

    // Mount resolves normally and fast with server A active -- this also
    // sets selectedInstallServerId once (fetchServers' own auto-select
    // branch), which matters below: with it already non-empty, neither of
    // the two activeServerChanged calls in this test re-triggers that
    // branch, so this test isolates the race on `servers` state alone
    // (a separate, unguarded bug exists in that auto-select branch itself --
    // it reads selectedInstallServerId from its OWN call's stale closure,
    // not the current value, and a late-resolving call can stomp a newer
    // manual selection; out of scope for this fix, flagged separately).
    getAll.mockResolvedValueOnce({ servers: [makeServer({ id: 1, name: 'Ashenwood', rconHost: '10.0.0.5', rconPort: 27015 })] })
    renderSettings()
    await screen.findByText('Ashenwood')
    expect(screen.getByText('10.0.0.5:27015')).toBeInTheDocument()

    // Call A (first activeServerChanged): held open -- stands in for a slow
    // response to whichever server was active when it fired.
    let resolveCallA: (value: Awaited<ReturnType<typeof serversApi.getAll>>) => void = () => {}
    const callA = new Promise<Awaited<ReturnType<typeof serversApi.getAll>>>((resolve) => { resolveCallA = resolve })
    getAll.mockImplementationOnce(() => callA)
    await act(async () => { emitActiveServerChanged() })

    // Call B (a second activeServerChanged, back to back): resolves
    // immediately with a NEW active server.
    getAll.mockResolvedValueOnce({ servers: [makeServer({ id: 2, name: 'Winterhaven', rconHost: '10.0.0.9', rconPort: 27020 })] })
    await act(async () => { emitActiveServerChanged() })
    await waitFor(() => expect(screen.getByText('Winterhaven')).toBeInTheDocument())
    expect(screen.getByText('10.0.0.9:27020')).toBeInTheDocument()

    // Call A finally lands, arriving strictly after call B's already-applied,
    // newer response, with the OLD active server.
    await act(async () => { resolveCallA({ servers: [makeServer({ id: 1, name: 'Ashenwood', rconHost: '10.0.0.5', rconPort: 27015 })] }) })

    // The bug: unfixed code has nothing gating this late apply, so it would
    // silently revert the RCON card back to Ashenwood even though
    // Winterhaven is the confirmed-current active server.
    expect(screen.getByText('Winterhaven')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.9:27020')).toBeInTheDocument()
    expect(screen.queryByText('Ashenwood')).not.toBeInTheDocument()
  })
})
