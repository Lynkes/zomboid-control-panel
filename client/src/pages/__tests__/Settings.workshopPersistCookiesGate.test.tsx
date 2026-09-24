import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi, serversApi, modsApi } from '@/lib/api'

// pz-pam-r23 (remaining client-side capability gates): WorkshopCollectionSyncCard's
// persistCookies prop is a thin wrapper around configApi.updateAppSettings()
// -- the same PUT /config/app-settings route (requirePermission("panel.settings"),
// confirmed via server/routes/config.js) the General Save button already
// gates -- but the two flows that actually persist Steam cookies ("Paste
// from clipboard" and the paste dialog's "Extract & Save") had no client-side
// check at all.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
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
    modsApi: { ...actual.modsApi, collectionBrowsers: vi.fn(), collectionDiff: vi.fn(), collectionExtractCookies: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getAllServers = vi.mocked(serversApi.getAll)
const collectionBrowsers = vi.mocked(modsApi.collectionBrowsers)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const collectionExtractCookies = vi.mocked(modsApi.collectionExtractCookies)

function primeCommonMocks() {
  getAppSettings.mockResolvedValue({
    settings: {
      panelPort: 8080,
      httpsEnabled: false,
      httpsPort: 8443,
      corsAllowedOrigins: '',
      autoReconnect: false,
      autoStartServer: false,
      workshopCollectionId: '123456789',
      steamSessionId: '',
      steamLoginSecure: '',
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
  collectionBrowsers.mockResolvedValue({ supported: false, browsers: [] } as never)
  collectionDiff.mockResolvedValue({ ok: false, error: 'No credentials configured', hasCredentials: false, tokenExpired: false } as never)
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=mods']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Settings.tsx: Workshop cookie paste is gated on panel.settings', () => {
  it('disables both save-triggering buttons and never calls updateAppSettings when the role lacks panel.settings', async () => {
    mockCan = (cap) => cap !== 'panel.settings'
    primeCommonMocks()

    renderSettings()

    const pasteManualButton = await screen.findByRole('button', { name: /paste (manually|cookies)/i })
    expect(pasteManualButton).not.toBeDisabled()
    fireEvent.click(pasteManualButton)

    const textarea = await screen.findByPlaceholderText(/copy as curl/i)
    fireEvent.change(textarea, {
      target: { value: 'sessionid=abc123; steamLoginSecure=76500000000000000%7C%7CtokenValue' },
    })

    const extractAndSaveButton = await screen.findByRole('button', { name: /extract.*save|saving/i })
    expect(extractAndSaveButton).toBeDisabled()

    fireEvent.click(extractAndSaveButton)
    await new Promise((r) => setTimeout(r, 0))
    expect(updateAppSettings).not.toHaveBeenCalled()
  })

  it('saves when the role has panel.settings', async () => {
    mockCan = () => true
    primeCommonMocks()
    updateAppSettings.mockResolvedValueOnce({} as never)

    renderSettings()

    const pasteManualButton = await screen.findByRole('button', { name: /paste (manually|cookies)/i })
    fireEvent.click(pasteManualButton)

    const textarea = await screen.findByPlaceholderText(/copy as curl/i)
    fireEvent.change(textarea, {
      target: { value: 'sessionid=abc123; steamLoginSecure=76500000000000000%7C%7CtokenValue' },
    })

    const extractAndSaveButton = await screen.findByRole('button', { name: /extract.*save|saving/i })
    expect(extractAndSaveButton).not.toBeDisabled()
    fireEvent.click(extractAndSaveButton)

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({
      steamSessionId: 'abc123',
      steamLoginSecure: '76500000000000000||tokenValue',
    }))
  })
})

// pz-pam-r26: handleAutoExtract (local-browser cookie extraction) is a
// SEPARATE route (POST /mods/collection/extract-cookies) from the rest of
// this card's persistCookies-based flows -- server/routes/mods.js gates
// its whole router behind requirePermission("mods.manage"), not
// panel.settings. Reuses mods.json's existing permissions.noModsManage
// string (cross-namespace t('mods:...')) rather than a new locale key.
describe('Settings.tsx: Workshop auto-detect-from-browser is gated on mods.manage', () => {
  it('disables the detected-browser button and never calls collectionExtractCookies when the role lacks mods.manage', async () => {
    mockCan = (cap) => cap !== 'mods.manage'
    primeCommonMocks()
    collectionBrowsers.mockResolvedValue({
      supported: true,
      browsers: [{ id: 'firefox', label: 'Firefox', detected: true }],
    } as never)

    renderSettings()

    const firefoxButton = await screen.findByRole('button', { name: /firefox/i })
    expect(firefoxButton).toBeDisabled()

    fireEvent.click(firefoxButton)
    await new Promise((r) => setTimeout(r, 0))
    expect(collectionExtractCookies).not.toHaveBeenCalled()
  })

  it('calls the real API when the role has mods.manage', async () => {
    mockCan = () => true
    primeCommonMocks()
    collectionBrowsers.mockResolvedValue({
      supported: true,
      browsers: [{ id: 'firefox', label: 'Firefox', detected: true }],
    } as never)
    collectionExtractCookies.mockResolvedValue({ ok: true, saved: true } as never)

    renderSettings()

    const firefoxButton = await screen.findByRole('button', { name: /firefox/i })
    expect(firefoxButton).not.toBeDisabled()
    fireEvent.click(firefoxButton)

    await waitFor(() => expect(collectionExtractCookies).toHaveBeenCalledWith('firefox'))
  })
})
