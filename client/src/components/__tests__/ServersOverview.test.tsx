import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ServersOverview } from '@/components/dashboard/ServersOverview'
import { ApiError, serversApi, type ServerInstance } from '@/lib/api'

// Every server on the Dashboard at once: state, players, auto-start and
// restart-if-it-goes-down for each, and Start, Stop and Restart for the
// servers other than the active one, without switching to them.

let mockCanManage = true
let mockCanControl = true
type Handler = () => void
let mockSocket: { on: (event: string, handler: Handler) => void; off: (event: string, handler: Handler) => void } | null = null
const mockToast = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    can: (capability: string) =>
      capability === 'servers.manage' ? mockCanManage : capability === 'server.control' ? mockCanControl : true,
  }),
}))

vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => mockSocket }))

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }))

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
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
    },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const activate = vi.mocked(serversApi.activate)
const startServer = vi.mocked(serversApi.start)
const stopServer = vi.mocked(serversApi.stop)
const restartServer = vi.mocked(serversApi.restart)

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
const ARENA = server('s4', 'Arena', { serverPort: 16265 })
const MYSTERY = server('s5', 'Mystery', { serverPort: 16267 })

function prime(servers: ServerInstance[]) {
  getAll.mockResolvedValue({ servers } as never)
  getStatus.mockResolvedValue({
    servers: [
      { id: 's1', name: 'LNKAlive', running: true, pid: '1', isActive: true, startedAt: null },
      { id: 's2', name: 'LNK-OUTBREAK', running: false, pid: null, isActive: false, startedAt: null },
      { id: 's3', name: 'Hosted', running: false, pid: null, isActive: false, startedAt: null },
      { id: 's4', name: 'Arena', running: true, pid: '4', isActive: false, startedAt: null },
      { id: 's5', name: 'Mystery', running: false, pid: null, isActive: false, startedAt: null, stateUnknown: true },
    ],
    detectedProcesses: 2,
    detectionError: null,
  } as never)
  getRconStatuses.mockResolvedValue({
    servers: [
      { id: 's1', status: 'connected', players: 3 },
      { id: 's2', status: 'unreachable', players: null },
      { id: 's3', status: 'connected', players: 7 },
      { id: 's4', status: 'connected', players: 0 },
      { id: 's5', status: 'unreachable', players: null },
    ],
  } as never)
}

function renderOverview(props: Partial<Parameters<typeof ServersOverview>[0]> = {}) {
  const onAutoStartChange = vi.fn()
  const onRestartOnCrashChange = vi.fn()
  const onShownChange = vi.fn()
  render(
    <TooltipProvider>
      <ServersOverview
        activeServerId="s1"
        autoStartSettings={{ autoStartServer: true, autoStartServerIds: ['s2'], restartOnCrashServerIds: ['s4'] }}
        canChangeAutoStart
        onAutoStartChange={onAutoStartChange}
        onRestartOnCrashChange={onRestartOnCrashChange}
        onShownChange={onShownChange}
        {...props}
      />
    </TooltipProvider>,
  )
  return { onAutoStartChange, onRestartOnCrashChange, onShownChange }
}

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCanManage = true
  mockCanControl = true
  mockSocket = null
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

  it('shows and hands over each local server\'s restart-if-it-goes-down choice', async () => {
    prime([ALIVE, ARENA, HOSTED])
    const { onRestartOnCrashChange } = renderOverview()

    await screen.findByText('Arena')
    expect(within(rowOf('Arena')).getByRole('checkbox', { name: 'Restart if it goes down' })).toBeChecked()
    const activeBox = within(rowOf('LNKAlive')).getByRole('checkbox', { name: 'Restart if it goes down' })
    expect(activeBox).not.toBeChecked()
    expect(within(rowOf('Hosted')).queryByRole('checkbox', { name: 'Restart if it goes down' })).not.toBeInTheDocument()

    fireEvent.click(activeBox)
    expect(onRestartOnCrashChange).toHaveBeenCalledWith(ALIVE, true)
  })

  it('offers Start for a stopped server and Stop and Restart for a running one, never for the active, a remote or an unknown one', async () => {
    prime([ALIVE, OUTBREAK, HOSTED, ARENA, MYSTERY])
    renderOverview()

    await screen.findByText('Mystery')
    expect(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' })).toBeEnabled()
    expect(within(rowOf('LNK-OUTBREAK')).queryByRole('button', { name: 'Stop LNK-OUTBREAK' })).not.toBeInTheDocument()
    expect(within(rowOf('Arena')).getByRole('button', { name: 'Stop Arena' })).toBeEnabled()
    expect(within(rowOf('Arena')).getByRole('button', { name: 'Restart Arena' })).toBeEnabled()
    for (const name of ['LNKAlive', 'Hosted', 'Mystery']) {
      const row = rowOf(name)
      for (const action of ['Start', 'Stop', 'Restart']) {
        expect(within(row).queryByRole('button', { name: `${action} ${name}` })).not.toBeInTheDocument()
      }
    }
  })

  it('starts another server where it stands, and refreshes the list', async () => {
    prime([ALIVE, OUTBREAK])
    startServer.mockResolvedValue({ success: true })
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const pollsBefore = getAll.mock.calls.length
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' }))

    await waitFor(() => expect(startServer).toHaveBeenCalledWith('s2'))
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({ title: 'Starting LNK-OUTBREAK' }))
    expect(activate).not.toHaveBeenCalled()
    await waitFor(() => expect(getAll.mock.calls.length).toBeGreaterThan(pollsBefore))
  })

  it('asks before stopping or restarting another server', async () => {
    prime([ALIVE, ARENA])
    stopServer.mockResolvedValue({ success: true, confirmed: false })
    restartServer.mockResolvedValue({ success: true })
    renderOverview()

    await screen.findByText('Arena')
    fireEvent.click(within(rowOf('Arena')).getByRole('button', { name: 'Stop Arena' }))
    const stopDialog = await screen.findByRole('alertdialog')
    expect(within(stopDialog).getByText('Stop Arena')).toBeInTheDocument()
    expect(stopServer).not.toHaveBeenCalled()
    fireEvent.click(within(stopDialog).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stopServer).toHaveBeenCalledWith('s4'))

    fireEvent.click(within(rowOf('Arena')).getByRole('button', { name: 'Restart Arena' }))
    const restartDialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(restartDialog).getByRole('button', { name: 'Restart' }))
    // The Dashboard's own Restart's 5-minute warning.
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('s4', 5))
  })

  it('says why a start was refused, in the operator\'s language', async () => {
    prime([ALIVE, OUTBREAK])
    startServer.mockRejectedValue(new ApiError('state unknown', {
      status: 409,
      code: 'SERVERS_ACTION_STATE_UNKNOWN',
      data: { code: 'SERVERS_ACTION_STATE_UNKNOWN', params: { name: 'LNK-OUTBREAK' } },
    }))
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    fireEvent.click(within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' }))

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({
      title: 'LNK-OUTBREAK didn\'t start',
      description: 'The panel can\'t tell whether LNK-OUTBREAK is running, so it did nothing. Try again in a moment.',
      variant: 'destructive',
    }))
  })

  it('offers Start, Stop and Restart only with server.control', async () => {
    mockCanControl = false
    prime([ALIVE, OUTBREAK])
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const start = within(rowOf('LNK-OUTBREAK')).getByRole('button', { name: 'Start LNK-OUTBREAK' })
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(startServer).not.toHaveBeenCalled()
  })

  it('refreshes when the server watch reports a server starting or stopping', async () => {
    const handlers: Record<string, Handler> = {}
    mockSocket = { on: (event, handler) => { handlers[event] = handler }, off: vi.fn() }
    prime([ALIVE, OUTBREAK])
    renderOverview()

    await screen.findByText('LNK-OUTBREAK')
    const pollsBefore = getAll.mock.calls.length
    act(() => handlers['servers:status']())

    await waitFor(() => expect(getAll.mock.calls.length).toBeGreaterThan(pollsBefore))
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
