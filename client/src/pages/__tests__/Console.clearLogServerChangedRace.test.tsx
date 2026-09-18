import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-09-18 (round 20): clearServerLog()'s confirm() dialog is a
// Promise that only resolves once the operator clicks Confirm/Cancel -- if
// the active server switches elsewhere WHILE that dialog is still open,
// serverApi.clearConsoleLog() resolves "the active server" server-side with
// no server id, so confirming the (now stale) dialog cleared the NEW
// server's log, not the one the operator opened the dialog for. This proves
// the fix: switch the server after the dialog opens but before Confirm is
// clicked, and assert the destructive call never fires.

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: null },
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
    rconApi: { ...actual.rconApi, getHistory: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

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
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getConsoleLog = vi.mocked(serverApi.getConsoleLog)
const clearConsoleLog = vi.mocked(serverApi.clearConsoleLog)
const getAllServers = vi.mocked(serversApi.getAll)
const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)

function makeServer(overrides: Partial<ServerInstance>): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '', rconPort: 0, rconPassword: '',
    serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
    isRemote: false, isActive: true, startCommand: '', adminPassword: '',
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

const serverA = makeServer({ id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood' })
const serverB = makeServer({ id: 2, name: 'Brightmoor', serverName: 'Brightmoor', installPath: 'C:/servers/brightmoor' })

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

describe('Console.tsx: clearServerLog refuses a stale confirm after the active server changed underneath it', () => {
  it('never calls clearConsoleLog when the server switches while the confirm dialog is open', async () => {
    // The switch's own reload (loadConsoleTarget's second getAllServers()
    // call) is held open deliberately -- the guard this test proves exists
    // protects the WHOLE window between the switch firing and that reload
    // landing, which in production can be anywhere from milliseconds to
    // seconds. A mock that resolves instantly would close that window
    // before the test ever gets to click Confirm, proving nothing.
    let resolveSwitch: (value: Awaited<ReturnType<typeof serversApi.getAll>>) => void = () => {}
    const switchPromise = new Promise<Awaited<ReturnType<typeof serversApi.getAll>>>((resolve) => { resolveSwitch = resolve })
    getAllServers
      .mockResolvedValueOnce({ servers: [serverA] })
      .mockImplementationOnce(() => switchPromise)
    getConsoleLog.mockResolvedValue({ lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true })
    clearConsoleLog.mockResolvedValue({ success: true })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockReset()

    renderConsole()
    await screen.findByText('boot ok')

    // Open the confirm dialog.
    fireEvent.click(screen.getByRole('button', { name: 'clear' }))
    await screen.findByText('Erase the console log for Ashenwood?')

    // The active server switches elsewhere WHILE the dialog is still open.
    // Its own reload is still in flight (held open above).
    await act(async () => { emitActiveServerChanged() })
    expect(getAllServers).toHaveBeenCalledTimes(2)

    // The operator, unaware of the switch, confirms the dialog they already
    // had open.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Erase log file' })) })

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Active server changed', variant: 'destructive' }),
    )
    expect(clearConsoleLog).not.toHaveBeenCalled()

    // Let the held-open switch resolve so it doesn't leak into the next test.
    await act(async () => { resolveSwitch({ servers: [serverB] }) })
  })

  it('still clears the log normally when nothing changed while the dialog was open (no false refusal)', async () => {
    getAllServers.mockResolvedValueOnce({ servers: [serverA] })
    getConsoleLog.mockResolvedValue({ lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true })
    clearConsoleLog.mockResolvedValue({ success: true })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockReset()

    renderConsole()
    await screen.findByText('boot ok')

    fireEvent.click(screen.getByRole('button', { name: 'clear' }))
    await screen.findByText('Erase the console log for Ashenwood?')
    fireEvent.click(screen.getByRole('button', { name: 'Erase log file' }))

    await waitFor(() => expect(clearConsoleLog).toHaveBeenCalledTimes(1))
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Active server changed' }),
    )
  })
})
