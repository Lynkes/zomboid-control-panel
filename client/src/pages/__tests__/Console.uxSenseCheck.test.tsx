import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// UX sense-check (2026-09-18, operator ask): first-time-operator pass over
// the Console page. Three gaps found and fixed here, each proven by a test
// that fails against the pre-fix copy:
//
// 1. clearServerLog()'s confirm() dialog named the consequence ("erases
//    server-console.txt, no undo") but never the TARGET SERVER -- unlike
//    every other destructive confirm in this app (Mods.tsx, ServerConfig.tsx,
//    Servers.tsx, Users.tsx all interpolate a name into the title/description).
//    An operator who just switched servers, or who has this panel open in two
//    tabs, had no way to tell from the dialog alone which server's log was
//    about to be erased.
// 2. Command History's search box filtered the list inline in the .map()
//    JSX with no "zero matches" branch -- searching for something with no
//    hits rendered a blank scroll area indistinguishable from a loading
//    glitch, not a genuine "nothing matches your search" state.
// 3. The Quick Commands row (Save, Players, Help, ...) reads like each
//    button executes immediately, but onClick only fills the command input
//    below -- Run/Enter is still required. Nothing told a first-time
//    operator that "Save" doesn't actually run save.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: null },
    authEnabled: true,
    isAuthenticated: false,
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
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: 'secret',
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
  getHistory.mockReset().mockResolvedValue({
    history: [
      { id: 1, command: 'players', response: 'Bob, Alice', success: 1, executed_at: '2026-09-18T10:00:00.000Z' },
      { id: 2, command: 'save', response: 'Saved', success: 1, executed_at: '2026-09-18T10:01:00.000Z' },
    ],
  })
  testRcon.mockReset().mockResolvedValue({ success: true, connected: true })
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

// The page opens on the "server log" tab by default; Radix Tabs unmounts
// the inactive TabsContent entirely (no forceMount here), so Quick
// Commands/History/the command input don't exist in the DOM at all until
// the "rcon console" tab is selected. Radix's TabsTrigger switches on
// mousedown, not click (see Console.rconUnreachableInputGating.test.tsx's
// own openRconTab helper) -- a plain fireEvent.click never flips it.
async function switchToRconTab() {
  const tab = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tab, { button: 0 })
}

describe('Console -- clear-log confirm names the target server', () => {
  it('shows the active server name in the confirm dialog title, not a generic "the server" phrase', async () => {
    renderConsole()

    const clearButton = await screen.findByRole('button', { name: 'clear' })
    fireEvent.click(clearButton)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Erase the console log for Ashenwood?')).toBeInTheDocument()
  })
})

describe('Console -- command history search with no matches', () => {
  it('tells the operator no entries matched instead of rendering a blank list', async () => {
    renderConsole()
    await switchToRconTab()

    // Open the collapsible history panel.
    const toggle = await screen.findByRole('button', { name: /history/i })
    fireEvent.click(toggle)

    await screen.findByText('players')

    const search = screen.getByPlaceholderText(enConsole.history.searchPlaceholder)
    fireEvent.change(search, { target: { value: 'zzz-nonexistent' } })

    await screen.findByText(enConsole.history.noMatchesTitle)
    expect(screen.getByText('No history entries match "zzz-nonexistent".')).toBeInTheDocument()
    // The genuinely-matching entries must not still be rendered underneath.
    expect(screen.queryByText('players')).not.toBeInTheDocument()

    // The "Clear search" action actually clears the search and restores the list.
    fireEvent.click(screen.getByRole('button', { name: enConsole.history.clearSearch }))
    await screen.findByText('players')
  })
})

describe('Console -- quick commands fill, they do not execute', () => {
  it('explains via the help tip that clicking a quick command only fills the input', async () => {
    renderConsole()
    await switchToRconTab()

    const help = await screen.findByRole('button', { name: 'Help: quick' })
    fireEvent.click(help)

    await waitFor(() =>
      expect(
        screen.getByText(/doesn't run until you click Run/i)
      ).toBeInTheDocument()
    )
  })

  it('clicking a quick command button fills the input instead of executing it', async () => {
    renderConsole()
    await switchToRconTab()

    const saveButton = await screen.findByRole('button', { name: 'Save' })
    await waitFor(() => expect(saveButton).not.toBeDisabled())
    fireEvent.click(saveButton)

    const input = screen.getByPlaceholderText(enConsole.rcon.placeholder) as HTMLInputElement
    expect(input.value).toBe('save')
  })
})
