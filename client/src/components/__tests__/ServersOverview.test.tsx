import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ServersOverview } from '@/components/dashboard/ServersOverview'
import { serversApi, type ServerInstance } from '@/lib/api'

// Every server on the Dashboard at once: state, players and auto-start for
// each, without switching the active server to see them.

let mockCanManage = true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ can: (capability: string) => (capability === 'servers.manage' ? mockCanManage : true) }),
}))

vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => null }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      activate: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const activate = vi.mocked(serversApi.activate)

function server(id: string, name: string, extra: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id, name, serverName: name, installPath: `/pz-servers/${name}`, zomboidDataPath: null, serverConfigPath: null,
    rconHost: '127.0.0.1', rconPort: 27015, rconPassword: '', serverPort: 16261, minMemory: 1, maxMemory: 8,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: false, startCommand: '', adminPassword: '',
    createdAt: new Date(0).toISOString(), ...extra,
  }
}

const ALIVE = server('s1', 'LNKAlive', { isActive: true, serverPort: 16261 })
const OUTBREAK = server('s2', 'LNK-OUTBREAK', { serverPort: 16263 })
const HOSTED = server('s3', 'Hosted', { isRemote: true, serverPort: 16300 })

function prime(servers: ServerInstance[]) {
  getAll.mockResolvedValue({ servers } as never)
  getStatus.mockResolvedValue({
    servers: [
      { id: 's1', name: 'LNKAlive', running: true, pid: '1', isActive: true, startedAt: null },
      { id: 's2', name: 'LNK-OUTBREAK', running: false, pid: null, isActive: false, startedAt: null },
      { id: 's3', name: 'Hosted', running: false, pid: null, isActive: false, startedAt: null },
    ],
    detectedProcesses: 1,
    detectionError: null,
  } as never)
  getRconStatuses.mockResolvedValue({
    servers: [
      { id: 's1', status: 'connected', players: 3 },
      { id: 's2', status: 'unreachable', players: null },
      { id: 's3', status: 'connected', players: 7 },
    ],
  } as never)
}

function renderOverview(props: Partial<Parameters<typeof ServersOverview>[0]> = {}) {
  const onAutoStartChange = vi.fn()
  const onShownChange = vi.fn()
  render(
    <TooltipProvider>
      <ServersOverview
        activeServerId="s1"
        autoStartSettings={{ autoStartServer: true, autoStartServerIds: ['s2'] }}
        canChangeAutoStart
        onAutoStartChange={onAutoStartChange}
        onShownChange={onShownChange}
        {...props}
      />
    </TooltipProvider>,
  )
  return { onAutoStartChange, onShownChange }
}

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCanManage = true
})

describe('ServersOverview', () => {
  it('stays out of the way with a single server', async () => {
    prime([ALIVE])
    const { onShownChange } = renderOverview()

    await waitFor(() => expect(getAll).toHaveBeenCalled())
    expect(screen.queryByText('Servers')).not.toBeInTheDocument()
    expect(onShownChange).not.toHaveBeenCalledWith(true)
  })

  it('lists every server with its state, players, port and auto-start', async () => {
    prime([ALIVE, OUTBREAK, HOSTED])
    const { onShownChange } = renderOverview()

    expect(await screen.findByText('LNK-OUTBREAK')).toBeInTheDocument()
    await waitFor(() => expect(onShownChange).toHaveBeenLastCalledWith(true))
    expect(screen.getByText('2 of 3 running')).toBeInTheDocument()

    const alive = rowOf('LNKAlive')
    expect(within(alive).getByText('Active')).toBeInTheDocument()
    expect(within(alive).getByText('Running')).toBeInTheDocument()
    expect(within(alive).getByText('Players online: 3')).toBeInTheDocument()
    expect(within(alive).getByText(':16261')).toBeInTheDocument()
    // On, but only LNK-OUTBREAK is chosen.
    expect(within(alive).getByRole('checkbox', { name: 'Start with the panel' })).not.toBeChecked()

    const outbreak = rowOf('LNK-OUTBREAK')
    expect(within(outbreak).getByText('Stopped')).toBeInTheDocument()
    expect(within(outbreak).getByText('Players: unknown (RCON isn\'t answering)')).toBeInTheDocument()
    expect(within(outbreak).getByRole('checkbox', { name: 'Start with the panel' })).toBeChecked()

    // A remote server: up when its RCON answers, and its host starts it.
    const hosted = rowOf('Hosted')
    expect(within(hosted).getByText('Running')).toBeInTheDocument()
    expect(within(hosted).queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('lists many installed and linked servers in a scrolling list, the active one first', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      server(`m${i}`, `Server ${i}`, { isRemote: i % 3 === 0, isActive: i === 7, serverPort: 16261 + i * 2 }))
    prime(many)
    renderOverview({ activeServerId: 'm7', autoStartSettings: { autoStartServer: false } })

    await screen.findByText('Server 11')
    const list = screen.getByTestId('servers-overview-list')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(12)
    expect(within(rows[0]).getByText('Server 7')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Active')).toBeInTheDocument()
    // Bounded height and scrollable, by keyboard too.
    expect(list).toHaveClass('max-h-[19rem]', 'overflow-y-auto')
    expect(list).toHaveAttribute('tabindex', '0')
  })

  it('hands an auto-start change for that row\'s server to the Dashboard', async () => {
    prime([ALIVE, OUTBREAK])
    const { onAutoStartChange } = renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    fireEvent.click(within(rowOf('LNKAlive')).getByRole('checkbox', { name: 'Start with the panel' }))

    expect(onAutoStartChange).toHaveBeenCalledWith(ALIVE, true)
  })

  it('switches the Dashboard to another server, and offers it only with servers.manage', async () => {
    prime([ALIVE, OUTBREAK])
    activate.mockResolvedValue({ server: OUTBREAK, message: 'ok' } as never)
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    expect(within(rowOf('LNKAlive')).queryByRole('button')).not.toBeInTheDocument()
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Show LNK-OUTBREAK on the Dashboard' }))

    await waitFor(() => expect(activate).toHaveBeenCalledWith('s2'))

    cleanup()
    mockCanManage = false
    renderOverview()
    await screen.findByText('LNK-OUTBREAK')
    expect(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Show LNK-OUTBREAK on the Dashboard' })).toBeDisabled()
  })
})
