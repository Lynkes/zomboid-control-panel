import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// bug-hunt-2026-09-18 (round 5): fetchHistory's catch branch only fired a
// toast (gone in a few seconds, and never seen at all if the collapsible
// History panel was opened after it expired, or opened for the first time
// well after mount). `history` stayed at its initial useState([]), which the
// panel rendered as "No command history" -- identical to a server that
// genuinely has never run a command. An operator has no way to tell "the
// fetch failed" apart from "this is really empty", and no in-panel way to
// retry short of an unrelated action that happens to call fetchHistory again.
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

const getConsoleLog = vi.mocked(serverApi.getConsoleLog)
const getAllServers = vi.mocked(serversApi.getAll)
const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)

const activeServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: 'C:/servers/ashenwood',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '',
  rconPort: 0,
  rconPassword: '',
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

beforeEach(() => {
  getAllServers.mockReset().mockResolvedValue({ servers: [activeServer] })
  getConsoleLog.mockReset().mockResolvedValue({ lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true })
  testRcon.mockReset()
  getHistory.mockReset()
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

async function openHistoryPanel() {
  // The History panel lives on the RCON Console tab, not the default
  // Server Log tab -- Radix's TabsTrigger switches on mousedown, not click
  // (see @radix-ui/react-tabs), and inactive tab content is hidden from the
  // accessibility tree, so findByRole for the history toggle hangs forever
  // without this.
  const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tabButton, { button: 0 })
  const toggle = await screen.findByRole('button', { name: enConsole.history.toggleLabel })
  fireEvent.click(toggle)
}

describe('Console -- command history load failure', () => {
  it('shows a retryable error state, not "no history", when the history fetch fails', async () => {
    getHistory.mockRejectedValue(new Error('network down'))

    renderConsole()
    await waitFor(() => expect(getHistory).toHaveBeenCalledTimes(1))
    await openHistoryPanel()

    // The bug: unfixed code renders this unconditionally once `history` is
    // still `[]`, with no way to distinguish "failed" from "really empty".
    expect(screen.queryByText(enConsole.history.emptyTitle)).not.toBeInTheDocument()
    await screen.findByText(enConsole.toasts.historyUnavailableTitle)
    await screen.findByText(enConsole.toasts.historyUnavailableDesc)
  })

  it('does not show the empty or error state while the initial fetch is still in flight', async () => {
    let resolveHistory: (value: { history: never[] }) => void = () => {}
    getHistory.mockReturnValue(new Promise((resolve) => { resolveHistory = resolve }))

    renderConsole()
    await openHistoryPanel()

    expect(screen.queryByText(enConsole.history.emptyTitle)).not.toBeInTheDocument()
    expect(screen.queryByText(enConsole.toasts.historyUnavailableTitle)).not.toBeInTheDocument()

    resolveHistory({ history: [] })
    await screen.findByText(enConsole.history.emptyTitle)
  })

  it('retrying a failed history fetch re-requests it and shows real entries on success', async () => {
    getHistory.mockRejectedValueOnce(new Error('network down'))

    renderConsole()
    await waitFor(() => expect(getHistory).toHaveBeenCalledTimes(1))
    await openHistoryPanel()
    await screen.findByText(enConsole.toasts.historyUnavailableTitle)

    getHistory.mockResolvedValueOnce({
      history: [{ id: 1, command: 'players', response: 'ok', success: true, executed_at: '2026-09-18T00:00:00.000Z' }],
    })
    const retryButton = await screen.findByRole('button', { name: enConsole.serverLog.retry })
    fireEvent.click(retryButton)

    await waitFor(() => expect(getHistory).toHaveBeenCalledTimes(2))
    await screen.findByText('players')
    expect(screen.queryByText(enConsole.toasts.historyUnavailableTitle)).not.toBeInTheDocument()
  })

  it('still shows the real empty state (not the error state) once history genuinely loads as empty', async () => {
    getHistory.mockResolvedValue({ history: [] })

    renderConsole()
    await waitFor(() => expect(getHistory).toHaveBeenCalledTimes(1))
    await openHistoryPanel()

    await screen.findByText(enConsole.history.emptyTitle)
    expect(screen.queryByText(enConsole.toasts.historyUnavailableTitle)).not.toBeInTheDocument()
  })
})
