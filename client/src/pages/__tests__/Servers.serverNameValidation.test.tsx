import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-09-18 (round 12, client-vs-server validation sweep): the
// Edit Server dialog's serverName field accepted any string up to 64 chars
// (a plain <Input maxLength={64}>, no character-set check) even though the
// server (server/routes/servers.js, isValidServerName/SERVER_NAME_REGEX)
// rejects anything but alphanumerics/underscore/hyphen/interior spaces with
// a generic 400 "Invalid server name" -- an operator who typed e.g. a
// leading space or a slash saw handleSaveEdit's generic
// toasts.updateServerFailed fallback with no field-level hint, only after
// the round trip. Same shape and fix pattern as
// Servers.duplicateRemoteServerEdit.test.tsx (which this test's scaffolding
// is copied from): block Save client-side, surface the server's own rule as
// an inline, persistent field marker instead of a one-shot toast.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const update = vi.mocked(serversApi.update)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

function makeServer(overrides: Record<string, unknown>) {
  return {
    id: 1,
    name: 'Ashenwood',
    serverName: 'ashenwood',
    installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null,
    serverConfigPath: null,
    rconHost: '127.0.0.1',
    rconPort: 27015,
    rconPassword: 'hunter2',
    serverPort: 16261,
    minMemory: 2,
    maxMemory: 4,
    useNoSteam: false,
    useDebug: false,
    isRemote: false,
    isActive: true,
    startCommand: '',
    adminPassword: '',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as never
}

const SERVER = makeServer({})

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
// documented in Servers.duplicateRemoteServerEdit.test.tsx.
async function openEditDialogFor(serverName: string) {
  const trigger = await screen.findByRole('button', { name: `Options for ${serverName}` })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByText(en.card.edit))
  await screen.findByRole('heading', { name: en.editDialog.title })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [SERVER] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
  update.mockReset().mockResolvedValue({ server: SERVER, warnings: [] } as never)
  toastSpy.mockClear()
})

describe('Servers -- Edit Server serverName must match the server-side character-set rule', () => {
  it('blocks saving a serverName with a leading space and never calls update', async () => {
    renderServers()
    await openEditDialogFor('Ashenwood')

    const serverNameInput = screen.getByDisplayValue('ashenwood')
    fireEvent.change(serverNameInput, { target: { value: ' ashenwood' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: en.editDialog.serverNameInvalid,
          variant: 'destructive',
        }),
      ),
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('blocks saving a serverName containing a path separator', async () => {
    renderServers()
    await openEditDialogFor('Ashenwood')

    const serverNameInput = screen.getByDisplayValue('ashenwood')
    fireEvent.change(serverNameInput, { target: { value: 'ashen/wood' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(update).not.toHaveBeenCalled()
  })

  it('shows a persistent inline marker on the field that clears the instant the value becomes valid again', async () => {
    renderServers()
    await openEditDialogFor('Ashenwood')

    const serverNameInput = screen.getByDisplayValue('ashenwood')
    fireEvent.change(serverNameInput, { target: { value: 'ashen!wood' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())

    expect(serverNameInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(en.editDialog.serverNameInvalid)).toBeInTheDocument()

    fireEvent.change(serverNameInput, { target: { value: 'ashenwood-2' } })
    expect(serverNameInput).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText(en.editDialog.serverNameInvalid)).not.toBeInTheDocument()
  })

  it('does not block saving a valid serverName', async () => {
    renderServers()
    await openEditDialogFor('Ashenwood')

    const serverNameInput = screen.getByDisplayValue('ashenwood')
    fireEvent.change(serverNameInput, { target: { value: 'ashenwood-renamed' } })

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: en.editDialog.serverNameInvalid }),
    )
  })
})
