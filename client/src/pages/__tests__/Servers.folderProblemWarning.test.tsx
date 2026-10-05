import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'
import enErrors from '@/locales/en/errors.json'

// PT3 (security sweep 2026-10-05, final round): a server whose data folder
// no longer meets the data-folder rule after the update, or whose record
// has a config folder but no data folder, lost features one by one, each
// with its own message or none. GET /api/servers now carries the refusal
// (`folderProblem`), and the server's card says it where the folders are
// set.

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
      getComposedStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
    },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
  }
})

const BASE = {
  serverConfigPath: null,
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
}
const REFUSED = {
  ...BASE,
  id: 1,
  name: 'refused-server',
  serverName: 'a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/home/someone',
  isActive: true,
  folderProblem: { error: 'raw server text', code: 'ZOMBOID_DATA_FOLDER_REFUSED' },
} as never
const FINE = {
  ...BASE,
  id: 2,
  name: 'fine-server',
  serverName: 'b-cfg',
  installPath: '/srv/b',
  zomboidDataPath: '/srv/b-data',
  isActive: false,
  folderProblem: null,
} as never

function cardFor(serverName: string): HTMLElement {
  const card = screen.getByText(serverName).closest('.overflow-hidden.transition-colors')
  if (!card) throw new Error(`could not find card container for ${serverName}`)
  return card as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("Servers.tsx: a card says when the panel won't use the server's folders", () => {
  it("shows the refusal on that server's card only", async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [REFUSED, FINE] } as never)
    vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] } as never)
    vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
      provider: 'native',
      selected: true,
      host: { status: 'stopped', label: 'Process', detail: null, startedAt: null },
      server: { status: 'disconnected', label: 'RCON', detail: null },
      bridge: { status: 'not-installed', label: 'PanelBridge', detail: null },
      summary: 'Stopped',
    } as never)
    vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] } as never)
    vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] } as never)
    vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
    vi.mocked(dockerApi.getStats).mockResolvedValue({ containers: {} } as never)
    vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as never)
    vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)

    render(
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
    await screen.findByText('fine-server')

    expect(cardFor('refused-server').textContent).toContain(enErrors.ZOMBOID_DATA_FOLDER_REFUSED)
    expect(cardFor('fine-server').textContent).not.toContain(enErrors.ZOMBOID_DATA_FOLDER_REFUSED)
  })
})
