import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, panelBridgeApi, serverApi, serversApi } from '@/lib/api'

// pz-bughunt round 21 (UX sense check, part 1): the Bridge tab used to be
// one flat ~860-line uncollapsed Card -- the operator's named worst scroll
// offender. Now split into 4 collapsible sections (status+setup open by
// default; remote RCON+SFTP; remote config+logs; install+updates). This
// proves all 4 sections render, that only "Status & setup" starts open,
// and that a collapsed section's content becomes reachable on click.

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
      getCorsDiagnostics: vi.fn(),
    },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getAllServers = vi.mocked(serversApi.getAll)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)

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
  getBridgeStatus.mockResolvedValue({
    isRunning: false,
    modConnected: false,
    bridgePath: null,
    connection: null,
  } as never)
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
})

describe('Settings.tsx: Bridge tab is split into collapsible sections', () => {
  it('renders all 4 section triggers, only Status & setup open by default, and a collapsed section opens on click', async () => {
    primeCommonMocks()
    renderSettings()

    const statusTrigger = await screen.findByRole('button', { name: /status & setup/i })
    const remoteConnTrigger = await screen.findByRole('button', { name: /remote connection/i })
    const remoteConfigTrigger = await screen.findByRole('button', { name: /remote config & logs/i })
    const installTrigger = await screen.findByRole('button', { name: /install & updates/i })

    expect(statusTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(remoteConnTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(remoteConfigTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(installTrigger).toHaveAttribute('aria-expanded', 'false')

    // Content unique to the collapsed "Install & updates" section is not
    // reachable until it's opened.
    expect(screen.queryByText(/install PanelBridge\.lua/i)).not.toBeInTheDocument()

    fireEvent.click(installTrigger)
    await waitFor(() => expect(installTrigger).toHaveAttribute('aria-expanded', 'true'))
    expect(await screen.findByText(/install PanelBridge\.lua/i)).toBeInTheDocument()
  })
})
