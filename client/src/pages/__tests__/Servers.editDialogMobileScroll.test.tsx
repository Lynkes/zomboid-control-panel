import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-09-18 (narrow-width sweep, round 2): the Edit Server dialog
// (DialogContent at "max-w-lg", no height bound) renders every field on this
// server -- display name, docker container, install/data paths, an optional
// lifecycle-provider block, custom start command, RCON host/port/password,
// admin password, game port, min/max memory -- well past 1500px tall.
// dialog.tsx's own DialogContent has no default max-height/overflow (unlike
// several OTHER dialogs in this app -- Mods.tsx, RolesPermissions.tsx,
// Settings.tsx, ConflictsPanel.tsx, TemplatePreviewDialog.tsx -- which all
// opt into `max-h-[85vh] overflow-y-auto`), so on a real short mobile
// viewport (verified with Playwright at 375x667, iPhone SE-class) the fixed,
// vertically-centered dialog ran off BOTH the top and bottom of the screen
// with no scroll affordance at all: the title was cut off above the fold,
// and the Save Changes / Cancel buttons sat ~340px below the bottom of the
// viewport -- completely unreachable, not just scrolled out of view. Fixed
// by applying the same max-h-[85vh] overflow-y-auto sm:max-h-[80vh] pattern
// this app already uses elsewhere for exactly this problem (Servers.tsx's
// own sibling Add-Remote-Server dialog already carries max-h-[90vh]
// overflow-y-auto). jsdom does not compute real layout, so this test can
// only assert the classes that produce the fix are present -- the actual
// on-screen behavior (dialog fits, Save Changes reachable via internal
// scroll at 375x667) was verified directly against a running instance with
// Playwright, not simulated here.
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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      update: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const SERVER_ONE = {
  id: 1,
  name: 'Server One',
  serverName: 'server-one',
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '192.168.1.50',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: true,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

// Radix's DropdownMenuTrigger opens on pointerdown, not click -- same quirk
// documented in Servers.duplicateRemoteServerEdit.test.tsx's identical helper.
async function openEditDialogFor(serverName: string) {
  const trigger = await screen.findByRole('button', { name: `Options for ${serverName}` })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByText(en.card.edit))
  await screen.findByRole('heading', { name: en.editDialog.title })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [SERVER_ONE] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
})

describe('Servers -- Edit Server dialog fits a short mobile viewport', () => {
  it('caps the dialog height and makes it internally scrollable, so its own footer buttons cannot run off-screen', async () => {
    renderServers()
    await openEditDialogFor('Server One')

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toMatch(/max-h-\[85vh\]/)
    expect(dialog.className).toMatch(/overflow-y-auto/)

    // The footer buttons must be inside the same scrollable element, not a
    // sibling the dialog's own height cap would leave unreachable.
    const saveButton = screen.getByRole('button', { name: /Save Changes/ })
    expect(dialog.contains(saveButton)).toBe(true)
  })
})
