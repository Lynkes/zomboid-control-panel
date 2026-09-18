import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// bug-hunt-2026-09-18 (console page hunt, stale-server races).
// Console.activeServerChanged.test.tsx only switches from a server WITH a log
// source to one WITHOUT, which flips the hasServerLogSource boolean and so
// re-runs the effects by accident. Switching between two servers that are both
// fully set up flips no boolean: the log poller, command-history fetch and RCON
// probe (all keyed on booleans) never re-ran, so the page kept showing the
// previous server's log lines, command history and RCON status under the new
// server's name -- and kept streaming the new server's file from the old
// server's byte offset. Separately, none of those fetches dropped a response
// that arrived after a newer request, so a slow answer for the server that was
// active a moment ago could overwrite the new server's data. And RCON commands
// (which carry no server id -- the backend resolves "the active server") could
// be sent in the window between the switch and the reload landing, running on a
// different server than the one on screen.

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
    serverApi: {
      ...actual.serverApi,
      getConsoleLog: vi.fn(),
      streamConsoleLog: vi.fn(),
      clearConsoleLog: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    rconApi: { ...actual.rconApi, execute: vi.fn(), getHistory: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
const emitActiveServerChanged = () => socketHandlers.get('activeServerChanged')?.forEach((h) => h())

const getAllServers = vi.mocked(serversApi.getAll)
const getConsoleLog = vi.mocked(serverApi.getConsoleLog)
const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)
const execute = vi.mocked(rconApi.execute)

function makeServer(id: number, name: string, dir: string): ServerInstance {
  return {
    id, name, serverName: name, installPath: dir, zomboidDataPath: null, serverConfigPath: null,
    rconHost: '10.0.0.5', rconPort: 27015, rconPassword: 'hunter2', serverPort: 16261,
    minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false, isRemote: false,
    isActive: true, startCommand: '', adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z',
  }
}
const serverA = makeServer(1, 'Ashenwood', 'C:/servers/ashenwood')
const serverB = makeServer(2, 'Brightmoor', 'C:/servers/brightmoor')

const logOf = (line: string, path: string) => ({ lines: [line], size: 50, path, exists: true })
const historyOf = (id: number, command: string) => ({
  history: [{ id, command, response: 'ok', success: 1, executed_at: '2026-01-01T00:00:00.000Z' }],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderConsole() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

const openRconTab = async () =>
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /rcon console/i }), { button: 0 })

describe('Console.tsx: switching between two fully configured servers reloads everything', () => {
  it('replaces the previous server\'s log, history and RCON probe with the new server\'s', async () => {
    getAllServers.mockResolvedValueOnce({ servers: [serverA] }).mockResolvedValueOnce({ servers: [serverB] })
    getConsoleLog
      .mockResolvedValueOnce(logOf('line from Ashenwood', 'C:/servers/ashenwood/server-console.txt'))
      .mockResolvedValueOnce(logOf('line from Brightmoor', 'C:/servers/brightmoor/server-console.txt'))
    getHistory
      .mockResolvedValueOnce(historyOf(1, 'cmd-on-ashenwood'))
      .mockResolvedValueOnce(historyOf(2, 'cmd-on-brightmoor'))
    testRcon.mockResolvedValue({ success: true, connected: true })
    vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 50 })

    renderConsole()
    await screen.findByText('line from Ashenwood')

    await act(async () => { emitActiveServerChanged() })

    expect(await screen.findByText('line from Brightmoor')).toBeInTheDocument()
    expect(screen.queryByText('line from Ashenwood')).not.toBeInTheDocument()
    expect(getConsoleLog).toHaveBeenCalledTimes(2)
    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(testRcon).toHaveBeenCalledTimes(2)

    await openRconTab()
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(enConsole.history.toggleLabel, 'i') }))
    expect(await screen.findByText('cmd-on-brightmoor')).toBeInTheDocument()
    expect(screen.queryByText('cmd-on-ashenwood')).not.toBeInTheDocument()
  })
})

describe('Console.tsx: nothing of the previous server stays on screen while the new one loads', () => {
  it('clears the old log lines immediately, even while the new log is still loading or fails', async () => {
    const pendingB = deferred<ReturnType<typeof logOf>>()
    getAllServers.mockResolvedValueOnce({ servers: [serverA] }).mockResolvedValueOnce({ servers: [serverB] })
    getConsoleLog
      .mockResolvedValueOnce(logOf('line from Ashenwood', 'C:/servers/ashenwood/server-console.txt'))
      .mockReturnValueOnce(pendingB.promise)
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })
    vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 50 })

    renderConsole()
    await screen.findByText('line from Ashenwood')

    await act(async () => { emitActiveServerChanged() })
    await waitFor(() => expect(getConsoleLog).toHaveBeenCalledTimes(2))

    expect(screen.queryByText('line from Ashenwood')).not.toBeInTheDocument()
    expect(screen.queryByText('C:/servers/ashenwood/server-console.txt')).not.toBeInTheDocument()
  })
})

describe('Console.tsx: a slow answer for the previous server never overwrites the new server\'s data', () => {
  it('drops a late server-log response for the server that was active before the switch', async () => {
    const lateA = deferred<ReturnType<typeof logOf>>()
    getAllServers.mockResolvedValueOnce({ servers: [serverA] }).mockResolvedValueOnce({ servers: [serverB] })
    getConsoleLog
      .mockReturnValueOnce(lateA.promise)
      .mockResolvedValueOnce(logOf('line from Brightmoor', 'C:/servers/brightmoor/server-console.txt'))
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })
    vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 50 })

    renderConsole()
    await waitFor(() => expect(getConsoleLog).toHaveBeenCalledTimes(1))

    await act(async () => { emitActiveServerChanged() })
    await screen.findByText('line from Brightmoor')

    await act(async () => { lateA.resolve(logOf('line from Ashenwood', 'C:/servers/ashenwood/server-console.txt')) })

    expect(screen.getByText('line from Brightmoor')).toBeInTheDocument()
    expect(screen.queryByText('line from Ashenwood')).not.toBeInTheDocument()
  })

  it('drops a late command-history response for the server that was active before the switch', async () => {
    const lateA = deferred<ReturnType<typeof historyOf>>()
    getAllServers.mockResolvedValueOnce({ servers: [serverA] }).mockResolvedValueOnce({ servers: [serverB] })
    getConsoleLog.mockResolvedValue(logOf('boot ok', 'C:/servers/x/server-console.txt'))
    vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 50 })
    getHistory
      .mockReturnValueOnce(lateA.promise)
      .mockResolvedValueOnce(historyOf(2, 'cmd-on-brightmoor'))
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole()
    await waitFor(() => expect(getHistory).toHaveBeenCalledTimes(1))

    await act(async () => { emitActiveServerChanged() })
    await waitFor(() => expect(getHistory).toHaveBeenCalledTimes(2))

    await openRconTab()
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(enConsole.history.toggleLabel, 'i') }))
    await screen.findByText('cmd-on-brightmoor')

    await act(async () => { lateA.resolve(historyOf(1, 'cmd-on-ashenwood')) })

    expect(screen.getByText('cmd-on-brightmoor')).toBeInTheDocument()
    expect(screen.queryByText('cmd-on-ashenwood')).not.toBeInTheDocument()
  })
})

describe('Console.tsx: RCON commands wait for the reload after a server switch', () => {
  it('refuses to send a command while the new active server is still loading, then sends once it landed', async () => {
    const reload = deferred<{ servers: ServerInstance[] }>()
    getAllServers.mockResolvedValueOnce({ servers: [serverA] }).mockReturnValueOnce(reload.promise)
    getConsoleLog.mockResolvedValue(logOf('boot ok', 'C:/servers/x/server-console.txt'))
    vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 50 })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })
    execute.mockResolvedValue({ success: true, response: 'saved' })

    renderConsole()
    await openRconTab()
    const input = await screen.findByLabelText(/rcon command input/i)
    fireEvent.change(input, { target: { value: 'save' } })

    await act(async () => { emitActiveServerChanged() })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(execute).not.toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: enConsole.toasts.serverChangedSinceLoadTitle }),
    )
    expect(screen.getByRole('button', { name: /execute command/i })).toBeDisabled()

    await act(async () => { reload.resolve({ servers: [serverB] }) })
    await waitFor(() => expect(screen.getByRole('button', { name: /execute command/i })).not.toBeDisabled())
    fireEvent.keyDown(screen.getByLabelText(/rcon command input/i), { key: 'Enter' })

    await waitFor(() => expect(execute).toHaveBeenCalledWith('save'))
  })
})
