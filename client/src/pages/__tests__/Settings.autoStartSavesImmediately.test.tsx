import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi, serversApi } from '@/lib/api'

// pz-bughunt round 21 (UX sense check, part 2): the Connection tab's
// auto-start switch used to only update local state, requiring the General
// tab's own Save button to persist it -- a split-persistence trap next to
// Dashboard.tsx's matching checkbox, which saves immediately. This proves
// the switch now saves immediately too (a scoped PUT, not the whole
// settings object), reverts on a failed save, and stays reachable without
// visiting the General tab.

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
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
      getCorsDiagnostics: vi.fn(),
    },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getAllServers = vi.mocked(serversApi.getAll)

function primeCommonMocks() {
  getAppSettings.mockResolvedValue({
    settings: {
      panelPort: 8080,
      httpsEnabled: false,
      httpsPort: 8443,
      corsAllowedOrigins: '',
      autoReconnect: false,
      autoStartServer: false,
    },
  } as never)
  getUpdateStatus.mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null,
    releaseUrl: null, releaseNotes: null, publishedAt: null, isChecking: false,
    isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  preflight.mockResolvedValue({
    ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
    info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
  } as never)
  getAllServers.mockResolvedValue({ servers: [] } as never)
  getCorsDiagnostics.mockResolvedValue({ diagnostics: null } as never)
  getNetworkInterfaces.mockResolvedValue({ interfaces: [] } as never)
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=connection']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings.tsx: Connection tab auto-start switch saves immediately', () => {
  it('calls a scoped PUT with just autoStartServer on toggle, with no General-tab Save needed', async () => {
    primeCommonMocks()
    updateAppSettings.mockResolvedValueOnce({} as never)
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: /start game servers when the panel starts/i })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ autoStartServer: true }))
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('reverts the switch when the save fails', async () => {
    primeCommonMocks()
    updateAppSettings.mockRejectedValueOnce(new Error('network down'))
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: /start game servers when the panel starts/i })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ autoStartServer: true }))
    await waitFor(() => expect(toggle).not.toBeChecked())
  })
})

// The switch used to start the active server alone; under it, a checkbox
// per local server now says which ones it starts.
describe('Settings.tsx: Connection tab lists the servers the switch starts', () => {
  function server(id: string, name: string, extra: Record<string, unknown> = {}) {
    return { id, name, serverName: name, isActive: false, isRemote: false, ...extra }
  }

  function primeServers(settings: Record<string, unknown>) {
    primeCommonMocks()
    getAppSettings.mockResolvedValue({
      settings: { panelPort: 8080, httpsEnabled: false, httpsPort: 8443, corsAllowedOrigins: '', ...settings },
    } as never)
    getAllServers.mockResolvedValue({
      servers: [
        server('s1', 'Ashenwood', { isActive: true }),
        server('s2', 'Riverside'),
        server('s3', 'Hosted', { isRemote: true }),
      ],
    } as never)
  }

  it('shows the active server chosen for a setting saved before servers could be chosen, and adds another to the list', async () => {
    primeServers({ autoStartServer: true })
    updateAppSettings.mockResolvedValueOnce({} as never)
    renderSettings()

    const active = await screen.findByRole('checkbox', { name: /Ashenwood/ })
    const other = screen.getByRole('checkbox', { name: /Riverside/ })
    expect(active).toBeChecked()
    expect(other).not.toBeChecked()
    // A remote server is started by its host, so it isn't offered.
    expect(screen.queryByRole('checkbox', { name: /Hosted/ })).not.toBeInTheDocument()

    fireEvent.click(other)

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ autoStartServerIds: ['s1', 's2'] }))
    await waitFor(() => expect(other).toBeChecked())
  })

  it('takes a server out of a saved list, and puts it back when the save fails', async () => {
    primeServers({ autoStartServer: true, autoStartServerIds: ['s2', 's1'] })
    updateAppSettings.mockRejectedValueOnce(new Error('network down'))
    renderSettings()

    const other = await screen.findByRole('checkbox', { name: /Riverside/ })
    expect(other).toBeChecked()

    fireEvent.click(other)

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ autoStartServerIds: ['s1'] }))
    await waitFor(() => expect(other).toBeChecked())
  })

  it('keeps the list read-only while the switch is off, and says when nothing is chosen', async () => {
    primeServers({ autoStartServer: false, autoStartServerIds: ['s2'] })
    renderSettings()

    const active = await screen.findByRole('checkbox', { name: /Ashenwood/ })
    expect(active).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Riverside/ })).toBeChecked()

    cleanup()
    primeServers({ autoStartServer: true, autoStartServerIds: [] })
    renderSettings()

    expect(await screen.findByText('No server is checked, so none will start.')).toBeInTheDocument()
  })
})
