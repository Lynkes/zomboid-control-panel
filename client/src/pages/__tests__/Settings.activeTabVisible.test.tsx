import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi, serversApi, permissionsApi, usersApi } from '@/lib/api'

// UX review D5 (live-verified on /settings?tab=users): the selected Settings
// tab had aria-selected="true" but data-state="closed" -- the Tooltip around
// each TabsTrigger (asChild) overwrites Radix Tabs' data-state="active" -- so
// every `data-[state=active]:` class on it never applied and no tab ever
// looked selected. The selected look must hang off a state the trigger
// really carries.

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
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

function primeMocks() {
  vi.mocked(configApi.getAppSettings).mockResolvedValue({
    settings: { panelPort: 8080, httpsEnabled: false, httpsPort: 8443, corsAllowedOrigins: '', autoReconnect: false, autoStartServer: false },
  } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null, releaseNotes: null,
    publishedAt: null, isChecking: false, isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  vi.mocked(panelUpdateApi.preflight).mockResolvedValue({
    ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
    info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
  } as never)
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(configApi.getCorsDiagnostics).mockResolvedValue({ diagnostics: null } as never)
  vi.mocked(serverApi.getNetworkInterfaces).mockResolvedValue({ interfaces: [] } as never)
  vi.mocked(permissionsApi.getCapabilities).mockResolvedValue({ groups: [] } as never)
  vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] } as never)
  vi.mocked(usersApi.list).mockResolvedValue({ users: [] } as never)
}

// The selected-look classes of the trigger that really apply given its
// attributes: data-[state=active]: needs data-state="active"; aria-selected:
// needs aria-selected="true"; a plain class always applies. The shared SubNav
// styles the selected row from the selected value itself (plain classes),
// never from data-state, which a wrapping Tooltip overwrites.
const SELECTED_LOOK = ['bg-primary/10', 'font-medium', 'text-foreground', 'text-primary']
function appliedSelectedClasses(trigger: HTMLElement): string[] {
  return [...trigger.classList].filter((cls) => {
    const utility = cls.slice(cls.lastIndexOf(':') + 1)
    if (!SELECTED_LOOK.includes(utility) || cls.startsWith('hover:') || cls.startsWith('group-hover:')) return false
    if (cls.startsWith('data-[state=active]:')) return trigger.getAttribute('data-state') === 'active'
    if (cls.startsWith('aria-selected:')) return trigger.getAttribute('aria-selected') === 'true'
    return !cls.includes(':')
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings: the selected tab looks selected', () => {
  it('styles the selected tab from a state the trigger carries, not from data-state the Tooltip overwrote', async () => {
    primeMocks()
    render(
      <MemoryRouter initialEntries={['/settings?tab=users']}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'Users' })
    const selected = screen.getByRole('tab', { selected: true })
    expect(selected).toHaveTextContent('Users')
    const applied = appliedSelectedClasses(selected)
    expect(applied).toContain('bg-primary/10')
    expect(applied).toContain('font-medium')

    // And the other tabs don't carry the selected look.
    const general = screen.getByRole('tab', { name: 'General' })
    expect(appliedSelectedClasses(general)).toEqual([])
  })
})
