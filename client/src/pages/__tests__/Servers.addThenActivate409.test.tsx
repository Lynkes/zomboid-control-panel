import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { ApiError, serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// Add Server creates the server and then activates it. Activation can be turned
// away on its own (409 while another lifecycle action holds the lock) after the
// server already exists. That used to be reported as "add failed" with the
// dialog still open, and a retry created a second server.

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
      create: vi.fn(),
      activate: vi.fn(),
    },
    serversDetectApi: { ...actual.serversDetectApi, detect: vi.fn(), autoScan: vi.fn() },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
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
const create = vi.mocked(serversApi.create)
const activate = vi.mocked(serversApi.activate)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const EXISTING_SERVER = {
  id: 1,
  name: 'Existing Remote',
  serverName: 'existing',
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
  isActive: true,
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

async function addRemoteServer(name: string) {
  await openAddFromHeader('remote')
  await screen.findByRole('heading', { name: en.addDialog.titleRemote })
  fireEvent.change(screen.getByPlaceholderText(en.remoteForm.displayNamePlaceholder), { target: { value: name } })
  fireEvent.change(screen.getByPlaceholderText(en.remoteForm.hostPlaceholder), { target: { value: '192.168.1.60' } })
  fireEvent.change(screen.getByPlaceholderText(en.remoteForm.rconPasswordPlaceholder), { target: { value: 'tourdemo' } })
  fireEvent.click(screen.getByRole('button', { name: en.addDialog.addServer }))
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [EXISTING_SERVER] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
  create.mockReset().mockResolvedValue({ server: { id: 9, name: 'Brand New' } } as never)
  activate.mockReset().mockResolvedValue({} as never)
  toastSpy.mockClear()
})

describe('Servers -- Add Server when activation is turned away', () => {
  it('closes the dialog, says the server was added but is not active yet, and never reports a failed add', async () => {
    activate.mockRejectedValue(
      new ApiError('Another server action is in progress.', { status: 409, code: 'SERVER_LIFECYCLE_IN_PROGRESS' }),
    )
    renderServers()

    await addRemoteServer('Brand New')

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: en.toasts.serverAddedNotActiveTitle,
          variant: 'warning',
          description: expect.stringContaining('Brand New'),
        }),
      ),
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(9)
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.serverAddedTitle }))
    // The dialog is gone, so there is nothing to submit a second time.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: en.addDialog.titleRemote })).not.toBeInTheDocument(),
    )
  })

  it('still reports a normal success when activation works', async () => {
    renderServers()

    await addRemoteServer('Brand New')

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.serverAddedTitle })),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.serverAddedNotActiveTitle }))
  })

  it('keeps the dialog open and reports the failure when creating itself fails', async () => {
    create.mockRejectedValue(new ApiError('Boom', { status: 500 }))
    renderServers()

    await addRemoteServer('Brand New')

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    )
    expect(activate).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: en.addDialog.titleRemote })).toBeInTheDocument()
  })
})

// The page header's "Add server" menu (UX restructure, one command primary):
// the existing-files and remote dialogs open from its items. Radix opens the
// menu on pointerdown.
async function openAddFromHeader(choice: 'existing' | 'remote') {
  const trigger = await screen.findByRole('button', { name: en.addServer.menu })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(en.addServer[choice].label) }))
}
