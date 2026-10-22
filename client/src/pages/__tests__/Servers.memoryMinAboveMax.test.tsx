import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers, { isMemoryMinAboveMax } from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// A minimum memory above the maximum is written to the start script as
// -Xms{min}g -Xmx{max}g, which the JVM refuses. The dialogs used to accept
// it; they now show the problem under the fields and block Save.

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
const update = vi.mocked(serversApi.update)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const LOCAL_SERVER = {
  id: 3,
  name: 'Local PZ',
  serverName: 'localpz',
  installPath: 'D:\\pz\\server',
  zomboidDataPath: 'D:\\pz\\data',
  serverConfigPath: 'D:\\pz\\data\\Server',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
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

async function openEditDialogFor(serverName: string) {
  const trigger = await screen.findByRole('button', { name: `Options for ${serverName}` })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByText(en.card.edit))
  await screen.findByRole('heading', { name: en.editDialog.title })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [LOCAL_SERVER] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
  update.mockReset().mockResolvedValue({ server: LOCAL_SERVER, warnings: [] } as never)
  toastSpy.mockClear()
})

describe('isMemoryMinAboveMax', () => {
  it('is only true for two numbers with the minimum above the maximum', () => {
    expect(isMemoryMinAboveMax(8, 4)).toBe(true)
    expect(isMemoryMinAboveMax(4, 4)).toBe(false)
    expect(isMemoryMinAboveMax(2, 4)).toBe(false)
    expect(isMemoryMinAboveMax(NaN, 4)).toBe(false)
    expect(isMemoryMinAboveMax(8, NaN)).toBe(false)
  })
})

describe('Servers -- Edit Server memory', () => {
  it('shows the problem under the fields and blocks Save when the minimum is above the maximum', async () => {
    renderServers()
    await openEditDialogFor('Local PZ')

    const minInput = screen.getByDisplayValue('2')
    const maxInput = screen.getByDisplayValue('4')
    expect(screen.queryByText(en.toasts.memoryMinAboveMaxError)).not.toBeInTheDocument()

    fireEvent.change(minInput, { target: { value: '8' } })

    expect(screen.getByText(en.toasts.memoryMinAboveMaxError)).toBeInTheDocument()
    expect(minInput).toHaveAttribute('aria-invalid', 'true')
    expect(maxInput).toHaveAttribute('aria-invalid', 'true')

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: en.toasts.memoryMinAboveMaxError, variant: 'destructive' }),
      ),
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('clears the problem as soon as the pair is back in order, and Save goes through', async () => {
    renderServers()
    await openEditDialogFor('Local PZ')

    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '8' } })
    expect(screen.getByText(en.toasts.memoryMinAboveMaxError)).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '16' } })
    expect(screen.queryByText(en.toasts.memoryMinAboveMaxError)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  })
})
