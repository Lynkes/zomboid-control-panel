import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'
import errorsEn from '../../locales/en/errors.json'

// bug-hunt-2026-09-18 (round 13, client error-code display sweep): a failed
// /rcon/execute response can carry `code: RCON_EXECUTE_DISCONNECTED` (server/
// services/rcon.js) alongside several DIFFERENT raw English `error` strings
// ("Server is not running", "RCON reconnection failed", or whatever
// getUserFriendlyError() classified the transport error as) -- Console.tsx
// already read `result.code` three lines above the toast to flip the
// connection banner, but the toast itself showed `result.error`'s raw prose
// unconditionally, ignoring the same code that was just checked. A non-
// English operator saw untranslated English instead of the already-
// registered, already-translated errors.json:RCON_EXECUTE_DISCONNECTED
// string every OTHER coded error path in this app resolves through
// getUserErrorMessage(). Same shape for the broadcast (servermsg) path.

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
    rconApi: {
      ...actual.rconApi,
      execute: vi.fn(),
      getHistory: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const execute = vi.mocked(rconApi.execute)
const getHistory = vi.mocked(rconApi.getHistory)
const getAllServers = vi.mocked(serversApi.getAll)
const testRcon = vi.mocked(configApi.testRcon)

const rconReadyServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '10.0.0.5',
  rconPort: 27015,
  rconPassword: 'hunter2',
  serverPort: 16261,
  minMemory: 2048,
  maxMemory: 4096,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

async function setUp() {
  getAllServers.mockResolvedValue({ servers: [rconReadyServer] })
  getHistory.mockResolvedValue({ history: [] })
  testRcon.mockResolvedValue({ success: true, connected: true })
}

async function openRconTab() {
  const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tabButton, { button: 0 })
}

async function runCommand(command: string) {
  const input = await screen.findByLabelText(/rcon command input/i)
  fireEvent.change(input, { target: { value: command } })
  const runButton = screen.getByRole('button', { name: /execute command/i })
  fireEvent.click(runButton)
}

describe('Console.tsx: a failed RCON command translates result.code instead of showing its raw prose', () => {
  it('shows the translated RCON_EXECUTE_DISCONNECTED string, not the raw "Server is not running" text', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'Server is not running',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    renderConsole()
    await openRconTab()
    await runCommand('players')

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: errorsEn.RCON_EXECUTE_DISCONNECTED,
          variant: 'destructive',
        }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Server is not running' }),
    )
  })

  it('still shows the raw text unchanged for an uncoded failure (bucket C -- no code means nothing to translate)', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'Server is starting, please wait...',
      code: null,
    })

    renderConsole()
    await openRconTab()
    await runCommand('players')

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Server is starting, please wait...',
          variant: 'destructive',
        }),
      ),
    )
  })
})

describe('Console.tsx: a failed broadcast translates result.code the same way', () => {
  async function openBroadcastSection() {
    const toggle = await screen.findByRole('button', { name: /broadcast/i })
    fireEvent.click(toggle)
  }

  it('shows the translated RCON_EXECUTE_DISCONNECTED string for a failed broadcast, not its raw prose', async () => {
    await setUp()
    execute.mockResolvedValue({
      success: false,
      error: 'RCON reconnection failed',
      code: 'RCON_EXECUTE_DISCONNECTED',
    })

    renderConsole()
    await openRconTab()
    await openBroadcastSection()
    const textarea = await screen.findByLabelText(/broadcast message/i)
    fireEvent.change(textarea, { target: { value: 'server restarting soon' } })
    const sendButton = screen.getByRole('button', { name: /^send$/i })
    fireEvent.click(sendButton)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: errorsEn.RCON_EXECUTE_DISCONNECTED,
          variant: 'destructive',
        }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'RCON reconnection failed' }),
    )
  })
})
