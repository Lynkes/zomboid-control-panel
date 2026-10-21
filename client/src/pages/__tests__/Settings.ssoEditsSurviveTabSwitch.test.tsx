import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'
import Settings from '../Settings'
import { configApi, oidcSettingsApi, panelBridgeApi, panelUpdateApi, serverApi, serversApi, permissionsApi, usersApi } from '@/lib/api'

// Settings › Single Sign-On saves on its own, behind its own save bar, and a
// ?tab= switch never asks (it is the same page). But the tab was unmounted
// on the switch and reloaded from the server on return: an issuer URL or
// client ID typed in, then a look at another tab (the panel's address on
// Remote access, say), was gone without a word. The tab now stays mounted
// while it holds edits, the rail marks it, and leaving the page asks.

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
    oidcSettingsApi: { ...actual.oidcSettingsApi, get: vi.fn(), update: vi.fn(), testConnection: vi.fn() },
  }
})

const SAVED_SSO = {
  issuerUrl: 'https://accounts.google.com',
  clientId: 'panel-client',
  redirectUri: 'https://panel.example/api/auth/oidc/callback',
  scope: 'openid email profile',
  providerName: 'Google',
  allowInsecureHttp: false,
  clientSecretConfigured: true,
  configured: true,
  envOverrides: { issuerUrl: false, clientId: false, redirectUri: false, scope: false, providerName: false, allowInsecureHttp: false, clientSecret: false },
  suggestedRedirectUri: 'https://panel.example/api/auth/oidc/callback',
  providerFieldsEditable: true,
}

function primeMocks() {
  vi.mocked(configApi.getAppSettings).mockResolvedValue({
    settings: { panelPort: '3001', httpsEnabled: false, httpsPort: '3443', corsAllowedOrigins: '', autoReconnect: false, autoStartServer: false },
  } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null, releaseNotes: null,
    publishedAt: null, isChecking: false, isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ isRunning: false, modConnected: false, bridgePath: null, connection: null } as never)
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(configApi.getCorsDiagnostics).mockResolvedValue({ diagnostics: null } as never)
  vi.mocked(serverApi.getNetworkInterfaces).mockResolvedValue({ interfaces: [] } as never)
  vi.mocked(permissionsApi.getCapabilities).mockResolvedValue({ groups: [] } as never)
  vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] } as never)
  vi.mocked(usersApi.list).mockResolvedValue({ users: [] } as never)
  vi.mocked(oidcSettingsApi.get).mockResolvedValue(SAVED_SSO as never)
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function renderSettings(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <ConfirmProvider>
          <UnsavedChangesProvider>
            <Settings />
            <Link to="/servers">Servers</Link>
            <Where />
          </UnsavedChangesProvider>
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › Single Sign-On: edits survive a tab switch', () => {
  it('keeps a typed edit across another tab, marks the tab, and asks before leaving the page', async () => {
    primeMocks()
    renderSettings('/settings?tab=sso')

    const name = await screen.findByLabelText('Display name', undefined, { timeout: 5000 })
    await waitFor(() => expect(name).toHaveValue('Google'))
    fireEvent.change(name, { target: { value: 'Company SSO' } })
    expect(await screen.findByText('Unsaved changes: 1')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Remote access' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Remote access', selected: true })).toBeInTheDocument())
    // Hidden, not shown on top of Remote access, and its save bar is gone.
    const ssoPanel = screen.getByLabelText('Display name').closest('[role="tabpanel"]')
    expect(ssoPanel).toHaveAttribute('data-state', 'inactive')
    expect(ssoPanel).toHaveClass('data-[state=inactive]:hidden')
    expect(screen.queryByText('Unsaved changes: 1')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Single Sign-On\s*\(unsaved changes\)$/ })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Single Sign-On/ }))
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveValue('Company SSO'))
    expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument()
    // Not fetched again: the form was kept, not reloaded.
    expect(oidcSettingsApi.get).toHaveBeenCalledTimes(1)

    // Away again, then off the page: the hidden edit still asks first.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'General' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'General', selected: true })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('link', { name: 'Servers' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await act(async () => {})
    expect(screen.getByTestId('where').textContent).toBe('/settings?tab=general')
  })

  it('lets the tab unmount as before once nothing is unsaved', async () => {
    primeMocks()
    renderSettings('/settings?tab=sso')
    await screen.findByLabelText('Display name', undefined, { timeout: 5000 })

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'General' }))
    await waitFor(() => expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Single Sign-On' })).toBeInTheDocument()
  })
})
