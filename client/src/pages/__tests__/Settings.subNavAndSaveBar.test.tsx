import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelBridgeApi, panelUpdateApi, serverApi, serversApi, permissionsApi, usersApi } from '@/lib/api'

// UX restructure (slice D): Settings uses the shared section rail (SubNav)
// with the selection in ?tab=, one save bar instead of the header Save and
// the warning banner, and the Backups tab no longer carries a second copy of
// the World Backups screen.

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
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), getCorsDiagnostics: vi.fn(), updateAppSettings: vi.fn() },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

function primeMocks() {
  vi.mocked(configApi.getAppSettings).mockResolvedValue({
    settings: { panelPort: '3001', httpsEnabled: false, httpsPort: '3443', corsAllowedOrigins: '', autoReconnect: false, autoStartServer: false },
  } as never)
  vi.mocked(configApi.updateAppSettings).mockResolvedValue({ success: true } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null, releaseNotes: null,
    publishedAt: null, isChecking: false, isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  vi.mocked(panelUpdateApi.preflight).mockResolvedValue({
    ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
    info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
  } as never)
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ isRunning: false, modConnected: false, bridgePath: null, connection: null } as never)
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(configApi.getCorsDiagnostics).mockResolvedValue({ diagnostics: null } as never)
  vi.mocked(serverApi.getNetworkInterfaces).mockResolvedValue({ interfaces: [] } as never)
  vi.mocked(permissionsApi.getCapabilities).mockResolvedValue({ groups: [] } as never)
  vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] } as never)
  vi.mocked(usersApi.list).mockResolvedValue({ users: [] } as never)
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function renderSettings(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <Settings />
        <LocationProbe />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings: the section rail lives in ?tab=', () => {
  it('opens the tab a link names, and picking another rewrites ?tab= while keeping the other parameters', async () => {
    primeMocks()
    renderSettings('/settings?tab=connection&from=diagnostics')

    expect(await screen.findByRole('tab', { name: 'RCON', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'RCON', level: 1 })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'HTTPS' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'HTTPS', selected: true })).toBeInTheDocument())
    const search = new URLSearchParams(screen.getByTestId('location').textContent!.split('?')[1])
    expect(search.get('tab')).toBe('https')
    expect(search.get('from')).toBe('diagnostics')
  })

  it('still reads the old tab names and falls back to General for an unknown one', async () => {
    primeMocks()
    renderSettings('/settings?tab=rcon')
    expect(await screen.findByRole('tab', { name: 'RCON', selected: true })).toBeInTheDocument()
    cleanup()

    renderSettings('/settings?tab=nope')
    expect(await screen.findByRole('tab', { name: 'General', selected: true })).toBeInTheDocument()
  })

  it('groups the rail into Panel, Access control, Game server, Automation and System, with Mods under a package icon', async () => {
    primeMocks()
    renderSettings('/settings')
    const rail = await screen.findByRole('tablist', { name: 'Settings sections' })
    for (const group of ['Panel', 'Access control', 'Game server', 'Automation', 'System']) {
      expect(within(rail).getByText(group)).toBeInTheDocument()
    }
    expect(within(rail).getByRole('tab', { name: 'Single Sign-On' })).toBeInTheDocument()
    expect(within(rail).getByRole('tab', { name: 'Mods & Workshop' }).querySelector('svg.lucide-package')).not.toBeNull()
  })
})

describe('Settings: one save bar for the shared settings', () => {
  it('marks the tab holding an edit, counts it, keeps it across tabs and puts it back on Discard', async () => {
    primeMocks()
    renderSettings('/settings?tab=general')

    const port = await screen.findByLabelText('Panel Port')
    await waitFor(() => expect(port).toHaveValue(3001))
    fireEvent.change(port, { target: { value: '3002' } })

    expect(await screen.findByText('Unsaved changes: 1')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^General\s*\(unsaved changes\)$/ })).toBeInTheDocument()

    // Another shared-settings tab still offers the same save.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'HTTPS' }))
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeEnabled()

    // The embedded Users tab saves on its own: no save bar there, but the
    // rail still says where the edit is.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Users' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument())
    expect(screen.getByRole('tab', { name: /^General\s*\(unsaved changes\)$/ })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: /General/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.getByLabelText('Panel Port')).toHaveValue(3001))
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument()
    expect(configApi.updateAppSettings).not.toHaveBeenCalled()
  })

  it('saves every edited setting with Ctrl+S', async () => {
    primeMocks()
    renderSettings('/settings?tab=general')
    const port = await screen.findByLabelText('Panel Port')
    await waitFor(() => expect(port).toHaveValue(3001))
    fireEvent.change(port, { target: { value: '3002' } })
    await screen.findByRole('button', { name: 'Save Changes' })

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(configApi.updateAppSettings).toHaveBeenCalledTimes(1))
    expect(vi.mocked(configApi.updateAppSettings).mock.calls[0][0]).toMatchObject({ panelPort: '3002' })
  })
})

describe('Settings › Backups: one home for world backups', () => {
  it('keeps character exports and links to World Backups instead of a second backup list', async () => {
    primeMocks()
    renderSettings('/settings?tab=backups')

    expect(await screen.findByRole('switch', { name: 'Export a character when a player joins' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open World Backups/ })).toHaveAttribute('href', '/backups?panel=schedule')
    expect(screen.queryByRole('switch', { name: 'Enable scheduled backups' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Backup Now/i })).not.toBeInTheDocument()
  })
})

describe('Settings › PanelBridge: the full live checks are in Diagnostics', () => {
  it('links the status section to Diagnostics › PanelBridge and keeps "How it works" in the header', async () => {
    primeMocks()
    renderSettings('/settings?tab=bridge')
    expect(await screen.findByRole('link', { name: /Open in Diagnostics/ })).toHaveAttribute('href', '/debug?tab=bridge')
    expect(screen.getByRole('button', { name: 'How it works' })).toBeInTheDocument()
  })
})
