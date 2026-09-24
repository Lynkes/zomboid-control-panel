import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi, serversApi, permissionsApi, usersApi } from '@/lib/api'

// pz-pam-r28 (approved r27 proposal): the Settings page header used to be
// hardcoded to the generic "Settings" title on every tab, and its Save
// action stayed visible (but semantically inert -- it only ever saves the
// general app-settings object) on the Users/Roles/SSO tabs, which are
// embedded standalone components with their own save mechanics. The
// header title now follows the active tab's own label, and the Save
// action is hidden on users/roles/sso specifically.

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
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getAllServers = vi.mocked(serversApi.getAll)
const getCapabilities = vi.mocked(permissionsApi.getCapabilities)
const getRoles = vi.mocked(permissionsApi.getRoles)
const listUsers = vi.mocked(usersApi.list)

function primeCommonMocks() {
  getAppSettings.mockResolvedValue({
    settings: {
      panelPort: 8080, httpsEnabled: false, httpsPort: 8443,
      corsAllowedOrigins: '', autoReconnect: false, autoStartServer: false,
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
  getCapabilities.mockResolvedValue({ groups: [] } as never)
  getRoles.mockResolvedValue({ roles: [] } as never)
  listUsers.mockResolvedValue({ users: [] } as never)
}

function renderSettings(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings?tab=${tab}`]}>
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

describe('Settings.tsx: page header title follows the active tab, Save hidden on users/roles/sso', () => {
  it('General tab: title follows the tab label, Save action present', async () => {
    primeCommonMocks()
    renderSettings('general')

    // "general" has its own settingsSections label ("General"), so the
    // t("pageHeader.title") fallback ("Settings") is only reached for a
    // genuinely unmatched tab id -- not exercised by any real tab,
    // General included. What matters here is what god actually asked for:
    // the Save action still shows on General.
    const heading = await screen.findByRole('heading', { name: 'General' })
    expect(heading).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /save/i }).length).toBeGreaterThan(0)
  })

  it('Roles tab: title follows the tab label, Save action is gone', async () => {
    primeCommonMocks()
    renderSettings('roles')

    const heading = await screen.findByRole('heading', { name: 'Roles & Permissions' })
    expect(heading).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save (changes|settings)/i })).not.toBeInTheDocument()
  })
})
