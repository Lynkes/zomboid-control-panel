import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, panelBridgeApi, serverApi, serversApi } from '@/lib/api'
import enSettings from '../../locales/en/settings.json'
import enDelivery from '../../locales/en/bridgeDelivery.json'
import { makeLocalStatus, makeWorkshopStatus } from '@/components/bridge/__tests__/deliveryFixtures'

// Spec §4.1/§4.13: Settings › PanelBridge carries the "How PanelBridge is
// installed" block right after the staleness alert and before the
// "not running" setup flow; with Workshop delivery that flow drops its
// upload-the-file and DoLuaChecksum=false steps (nothing to upload, and the
// check may stay on) but keeps the watcher setup, which both methods need.

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
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), getCorsDiagnostics: vi.fn() },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), getDelivery: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getDelivery = vi.mocked(panelBridgeApi.getDelivery)
const getAllServers = vi.mocked(serversApi.getAll)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)

function prime(deliveryMethod: 'local' | 'workshop') {
  getAppSettings.mockResolvedValue({ settings: { panelPort: 8080, httpsEnabled: false, httpsPort: 8443, corsAllowedOrigins: '', autoReconnect: false } } as never)
  getUpdateStatus.mockResolvedValue({ currentVersion: '1.0.0', updateAvailable: false, isChecking: false, isDownloading: false, downloadProgress: 0, updateMode: 'direct' } as never)
  preflight.mockResolvedValue({ ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [], info: { isPackaged: true, platform: 'win32', updateMode: 'direct' } } as never)
  getCorsDiagnostics.mockResolvedValue({ diagnostics: null } as never)
  getNetworkInterfaces.mockResolvedValue({ interfaces: [] } as never)
  getAllServers.mockResolvedValue({
    servers: [{ id: 'srv-1', name: 'Main Server', serverName: 'servertest', isActive: true, isRemote: false, installPath: 'D:\\PZServer' }],
  } as never)
  getBridgeStatus.mockResolvedValue({ isRunning: false, modConnected: false, bridgePath: null, connection: null, deliveryMethod } as never)
  getDelivery.mockResolvedValue(deliveryMethod === 'workshop' ? makeWorkshopStatus() : makeLocalStatus())
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

// <Trans> splits "<b>PanelBridge.lua</b>" into its own element, so match on
// the list item's whole text.
const listItemText = (text: string) => (_: string, el: Element | null) => el?.tagName === 'LI' && el.textContent === text

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › PanelBridge: delivery block and setup flow', () => {
  it('shows the delivery block between the status area and the setup flow', async () => {
    prime('local')
    renderSettings()
    const heading = await screen.findByRole('heading', { name: enDelivery.sectionTitle })
    const setupTitle = await screen.findByText(enSettings.bridge.getStartedTitle)
    // DOCUMENT_POSITION_FOLLOWING: the setup flow comes after the block.
    expect(heading.compareDocumentPosition(setupTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(getDelivery).toHaveBeenCalled()
  })

  it('local delivery keeps the upload and DoLuaChecksum steps', async () => {
    prime('local')
    renderSettings()
    await screen.findByText(enSettings.bridge.getStartedTitle)
    expect(screen.getByText(listItemText('Install PanelBridge.lua using the section below'))).toBeInTheDocument()
    expect(screen.getByText(listItemText('Set DoLuaChecksum=false in your server INI'))).toBeInTheDocument()
    expect(screen.queryByText(enDelivery.setupNote.workshop)).toBeNull()
  })

  it('Workshop delivery drops those two steps, points at the block, and keeps Auto Setup', async () => {
    prime('workshop')
    renderSettings()
    expect(await screen.findByText(enDelivery.setupNote.workshop)).toBeInTheDocument()
    expect(screen.queryByText(listItemText('Install PanelBridge.lua using the section below'))).toBeNull()
    expect(screen.queryByText(listItemText('Set DoLuaChecksum=false in your server INI'))).toBeNull()
    expect(screen.getByText(listItemText('Click Auto Setup to start the bridge watcher'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: enSettings.bridge.autoSetupButton })).toBeInTheDocument()
  })

  it('the Install & updates section uses the per-method wording', async () => {
    prime('local')
    renderSettings()
    fireEvent.click(await screen.findByText(enSettings.bridge.sectionInstallUpdates))
    expect(await screen.findByText(enSettings.bridge.autoUpdateLabel)).toBeInTheDocument()
    expect(screen.getByText(enSettings.bridge.autoUpdateDesc)).toBeInTheDocument()
    expect(enSettings.bridge.autoUpdateDesc).toContain('Not used with Steam Workshop delivery')
  })
})
