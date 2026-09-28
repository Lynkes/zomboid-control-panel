import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { ApiError, configApi, panelUpdateApi, panelBridgeApi, serverApi, serversApi } from '@/lib/api'
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

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), getCorsDiagnostics: vi.fn() },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), getDelivery: vi.fn(), installModAuto: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getCorsDiagnostics = vi.mocked(configApi.getCorsDiagnostics)
const getUpdateStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getDelivery = vi.mocked(panelBridgeApi.getDelivery)
const installModAuto = vi.mocked(panelBridgeApi.installModAuto)
const getAllServers = vi.mocked(serversApi.getAll)
const getNetworkInterfaces = vi.mocked(serverApi.getNetworkInterfaces)

function prime(deliveryMethod: 'local' | 'workshop', bridge: { isRunning: boolean } = { isRunning: false }) {
  getAppSettings.mockResolvedValue({ settings: { panelPort: 8080, httpsEnabled: false, httpsPort: 8443, corsAllowedOrigins: '', autoReconnect: false } } as never)
  getUpdateStatus.mockResolvedValue({ currentVersion: '1.0.0', updateAvailable: false, isChecking: false, isDownloading: false, downloadProgress: 0, updateMode: 'direct' } as never)
  preflight.mockResolvedValue({ ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [], info: { isPackaged: true, platform: 'win32', updateMode: 'direct' } } as never)
  getCorsDiagnostics.mockResolvedValue({ diagnostics: null } as never)
  getNetworkInterfaces.mockResolvedValue({ interfaces: [] } as never)
  getAllServers.mockResolvedValue({
    servers: [{ id: 'srv-1', name: 'Main Server', serverName: 'servertest', isActive: true, isRemote: false, installPath: 'D:\\PZServer' }],
  } as never)
  getBridgeStatus.mockResolvedValue({ isRunning: bridge.isRunning, modConnected: false, bridgePath: null, connection: null, deliveryMethod } as never)
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

  it('the Workshop setup note keeps the until-confirmed DoLuaChecksum rule (§4.6)', () => {
    expect(enDelivery.setupNote.workshop).toContain('DoLuaChecksum=false')
    expect(enDelivery.setupNote.workshop).toContain(enDelivery.sectionTitle)
  })

  it('"Waiting for PZ mod" asks a Workshop server for a start, not for PanelBridge.lua', async () => {
    prime('workshop', { isRunning: true })
    renderSettings()
    expect(await screen.findByText(enSettings.bridge.waitingForModTitle)).toBeInTheDocument()
    expect(screen.getByText(enDelivery.setupNote.waitingWorkshop)).toBeInTheDocument()
    expect(screen.queryByText(enSettings.bridge.waitingLocal)).toBeNull()
  })

  it('"Waiting for PZ mod" keeps the local wording for panel-installed delivery', async () => {
    prime('local', { isRunning: true })
    renderSettings()
    expect(await screen.findByText(enSettings.bridge.waitingLocal)).toBeInTheDocument()
    expect(screen.queryByText(enDelivery.setupNote.waitingWorkshop)).toBeNull()
  })

  it('the Install & updates section uses the per-method wording', async () => {
    prime('local')
    renderSettings()
    fireEvent.click(await screen.findByText(enSettings.bridge.sectionInstallUpdates))
    expect(await screen.findByText(enSettings.bridge.autoUpdateLabel)).toBeInTheDocument()
    expect(screen.getByText(enSettings.bridge.autoUpdateDesc)).toBeInTheDocument()
    expect(enSettings.bridge.autoUpdateDesc).toContain('Not used with Steam Workshop delivery')
  })

  it('an Install the server is still finishing (504 STILL_RUNNING) is an info toast, not "Installation Failed"', async () => {
    prime('local')
    installModAuto.mockRejectedValue(
      new ApiError('Installing PanelBridge is taking longer than usual and continues in the background.', {
        status: 504,
        code: 'PANELBRIDGE_INSTALL_STILL_RUNNING',
      }),
    )
    renderSettings()
    fireEvent.click(await screen.findByText(enSettings.bridge.sectionInstallUpdates))
    const install = await screen.findByRole('button', { name: enSettings.bridge.installButton })
    await waitFor(() => expect(install).toBeEnabled())
    fireEvent.click(install)
    await waitFor(() => expect(installModAuto).toHaveBeenCalledWith('srv-1'))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: enSettings.toasts.bridgeInstallStillRunning.title }),
      ),
    )
    const call = toastMock.mock.calls.find(([arg]) => arg?.title === enSettings.toasts.bridgeInstallStillRunning.title)?.[0]
    expect(call?.variant).toBeUndefined()
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: enSettings.toasts.installFailed.title }))
  })

  it('a real install failure still reads "Installation Failed"', async () => {
    prime('local')
    installModAuto.mockRejectedValue(new ApiError('Disk full', { status: 500, code: 'PANELBRIDGE_INSTALL_FAILED' }))
    renderSettings()
    fireEvent.click(await screen.findByText(enSettings.bridge.sectionInstallUpdates))
    const install = await screen.findByRole('button', { name: enSettings.bridge.installButton })
    await waitFor(() => expect(install).toBeEnabled())
    fireEvent.click(install)
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: enSettings.toasts.installFailed.title, variant: 'destructive' }),
      ),
    )
  })
})
