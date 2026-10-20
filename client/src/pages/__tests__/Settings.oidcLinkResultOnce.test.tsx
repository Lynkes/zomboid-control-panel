import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Settings from '../Settings'
import { configApi, panelBridgeApi, panelUpdateApi, serverApi, serversApi, permissionsApi, usersApi } from '@/lib/api'

// The SSO link callback lands on /settings?tab=users&oidcSuccess=linked&
// linkedUser=<id>, and the "SSO linked" toast names whose identity was
// linked. It never showed: Settings rendered its tabs once before loading,
// then swapped them for the skeleton, so Users' first mount read and
// stripped the result and the second had nothing left to say. And Users
// stripped it with history.replaceState, which left it in the router's
// location: Settings' next tab switch (keeping the other parameters) wrote
// it back, for the Users tab to read again.

const toastSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  toast: toastSpy,
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', username: 'admin', role: 'admin', capabilities: [] },
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
  vi.mocked(usersApi.list).mockResolvedValue({
    users: [{
      id: 'u1', username: 'alice', role: 'moderator', roleId: null, createdAt: '2026-01-01T00:00:00.000Z', lastLogin: null,
      externalIdentities: [{ issuer: 'https://sso.example', subject: '••••4321', email: 'alice@example.com', linkedAt: '2026-10-01T00:00:00.000Z' }],
    }],
  } as never)
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

const linkedToasts = () => toastSpy.mock.calls.filter(([arg]) => arg?.title === 'SSO linked')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('Settings › Users after an SSO link', () => {
  it('says "SSO linked" once, and switching tabs does not bring the link result back', async () => {
    primeMocks()
    window.history.replaceState(null, '', '/settings?tab=users&oidcSuccess=linked&linkedUser=u1')
    render(
      <BrowserRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <Settings />
            <LocationProbe />
          </ConfirmProvider>
        </TooltipProvider>
      </BrowserRouter>,
    )

    await waitFor(() => expect(linkedToasts()).toHaveLength(1), { timeout: 10000 })
    // The router's own location, which the next ?tab= change builds on.
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/settings?tab=users'))
    expect(window.location.search).toBe('?tab=users')

    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Roles & Permissions' }, { timeout: 10000 }))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('tab')).toBe('roles'))
    expect(window.location.search).not.toContain('oidcSuccess')

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Users' }))
    expect(await screen.findByText('alice', undefined, { timeout: 10000 })).toBeInTheDocument()
    // Give a second toast every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(linkedToasts()).toHaveLength(1)
    expect(window.location.search).toBe('?tab=users')
  })
})
