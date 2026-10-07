import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi } from '@/lib/api'

// A minimum memory of 0 is "automatic" (no -Xms, server/utils/memory.js):
// the card says so instead of showing a 0 GB minimum.

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
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  maxMemory: 8,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: a minimum memory of 0', () => {
  it('reads "auto" on the card, next to a server with a set minimum', async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({
      servers: [
        { ...BASE, id: 1, name: 'auto-heap', serverName: 'a', installPath: '/srv/a', isActive: true, minMemory: 0 },
        { ...BASE, id: 2, name: 'fixed-heap', serverName: 'b', installPath: '/srv/b', isActive: false, minMemory: 2 },
      ],
    } as never)
    vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] } as never)
    vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('not in this fixture'))
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

    expect(await screen.findByText('auto–8 GB')).toBeInTheDocument()
    expect(screen.getByText('2–8 GB')).toBeInTheDocument()
  })
})
