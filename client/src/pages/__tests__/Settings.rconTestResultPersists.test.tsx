import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi, serversApi } from '@/lib/api'

// pz-bughunt round 20 (UX sense check): the RCON "Test Connection" result
// used to only ever appear as a transient toast -- once it faded there was
// no way to tell whether the last test passed without clicking it again.
// Settings.tsx now keeps the last outcome in state and renders it next to
// the button until a new test replaces it.

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
      reloadCorsDiagnostics: vi.fn(),
      getCorsDiagnostics: vi.fn(),
      testRcon: vi.fn(),
    },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, autoConfigure: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const testRcon = vi.mocked(configApi.testRcon)
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

describe('Settings.tsx: RCON Test Connection result stays visible until the next test', () => {
  it('shows nothing before a test, "Connected" after a success, and "Failed" after a later failure', async () => {
    primeCommonMocks()
    renderSettings()

    const testButton = await screen.findByRole('button', { name: /test connection/i })
    expect(screen.queryByText(/^connected$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^failed$/i)).not.toBeInTheDocument()

    testRcon.mockResolvedValueOnce({} as never)
    fireEvent.click(testButton)
    // The result span also renders a timestamp right after the word, as a
    // separate adjacent text node ("Connected 9:10:50 AM") -- match the
    // word itself, not the whole (time-varying) node text.
    await waitFor(() => expect(screen.getByText(/connected/i)).toBeInTheDocument())
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()

    testRcon.mockRejectedValueOnce(new Error('connection refused'))
    fireEvent.click(testButton)
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument()
  })
})
