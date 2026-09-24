import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor, fireEvent } from '@testing-library/react'
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

// bug-hunt-2026-09-18 (round 11): a real pointer interaction on a Radix
// Select throws in jsdom -- same workaround as
// Events.safehouseAddPlayerPicker.test.tsx/Events.vehicleSirenControl.test.tsx:
// swap the picker for a native <select>, which drives the same
// onValueChange. Settings.tsx's Bridge tab (the only tab rendered by
// renderSettings() below) has exactly one <Select> -- the install-server
// picker -- so this mock is unambiguous within this file.
vi.mock('@/components/ui/select', () => {
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select
        aria-label="install-server"
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="" disabled></option>
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})
Element.prototype.scrollIntoView = vi.fn()

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

// pz-bughunt round 21 (UX sense check, part 1): the Bridge tab's RCON
// card (shows the active server's name/host:port -- what this whole file
// races on) and its install-server picker now live inside collapsible
// sections that default CLOSED ("Status & setup" is the only one open by
// default). Radix unmounts a closed section's content entirely, so both
// need an explicit open before this file's pre-existing assertions can
// find them -- same DOM either way once opened, this just adds the click
// a real operator would make first.
async function openRconAndInstallSections() {
  fireEvent.click(await screen.findByRole('button', { name: /remote connection/i }))
  fireEvent.click(await screen.findByRole('button', { name: /install & updates/i }))
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
    // branch (see the second test below for that branch's own, separate
    // race), so this test isolates the race on `servers` state alone.
    getAll.mockResolvedValueOnce({ servers: [makeServer({ id: 1, name: 'Ashenwood', rconHost: '10.0.0.5', rconPort: 27015 })] })
    renderSettings()
    await openRconAndInstallSections()
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

  // bug-hunt-2026-09-18 (round 10 finding, round 11 fix): fetchServers'
  // auto-select-active-server branch used to read selectedInstallServerId
  // from its OWN call's closure instead of current state -- a call issued
  // while nothing was selected yet (so its closure captured "") that stays
  // in flight across a manual pick would still see its own stale, captured
  // "falsy" reading on resolution and silently overwrite the user's pick.
  // Note this is NOT the same race as the test above: serversGuard's
  // isStale() check only orders overlapping fetchServers CALLS against each
  // other -- the call below is the only (and therefore newest, never
  // "stale") fetchServers call in flight, so the guard alone does not (and
  // is not meant to) protect this branch.
  it('does not let a late-resolving auto-select response overwrite a manual server selection', async () => {
    setUpCommon()

    // Mount resolves with two servers, NEITHER active -- fetchServers' own
    // auto-select branch is skipped (no activeServer found), so
    // selectedInstallServerId stays "" even after this call settles. This
    // is what lets the next call's closure also capture "".
    getAll.mockResolvedValueOnce({
      servers: [
        makeServer({ id: 1, name: 'Ashenwood', isActive: false, rconHost: '10.0.0.5', rconPort: 27015 }),
        makeServer({ id: 2, name: 'Winterhaven', isActive: false, rconHost: '10.0.0.9', rconPort: 27020 }),
      ],
    })
    renderSettings()
    await openRconAndInstallSections()
    await screen.findByText(/Ashenwood/)
    const select = await screen.findByRole('combobox', { name: 'install-server' })
    expect((select as HTMLSelectElement).value).toBe('')

    // A second fetchServers call (activeServerChanged) starts while
    // selectedInstallServerId is still "" -- its closure captures that same
    // falsy value. Held open: stands in for a slow response.
    let resolveStaleCall: (value: Awaited<ReturnType<typeof serversApi.getAll>>) => void = () => {}
    const staleCall = new Promise<Awaited<ReturnType<typeof serversApi.getAll>>>((resolve) => { resolveStaleCall = resolve })
    getAll.mockImplementationOnce(() => staleCall)
    await act(async () => { emitActiveServerChanged() })

    // While that call is still in flight, the admin manually picks
    // Winterhaven from the dropdown.
    await act(async () => { fireEvent.change(select, { target: { value: '2' } }) })
    expect((select as HTMLSelectElement).value).toBe('2')

    // The stale call finally lands, reporting Ashenwood as now active --
    // exercising the exact auto-select branch that used to fire off this
    // call's own captured (falsy) selectedInstallServerId.
    await act(async () => {
      resolveStaleCall({
        servers: [
          makeServer({ id: 1, name: 'Ashenwood', isActive: true, rconHost: '10.0.0.5', rconPort: 27015 }),
          makeServer({ id: 2, name: 'Winterhaven', isActive: false, rconHost: '10.0.0.9', rconPort: 27020 }),
        ],
      })
    })

    // The bug: unfixed code reads its own stale closure ("") instead of the
    // live selection and silently reverts the dropdown to Ashenwood (id 1)
    // even though the admin explicitly picked Winterhaven (id 2).
    expect((select as HTMLSelectElement).value).toBe('2')
  })
})
