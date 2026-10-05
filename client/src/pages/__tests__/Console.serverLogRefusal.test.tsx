import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { serverApi, serversApi, rconApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'
import enErrors from '../../locales/en/errors.json'

// PT3 (security sweep 2026-10-05, final round): when the panel won't read a
// server's console log -- its data folder no longer meets the data-folder
// rule after the update, or none is set -- GET /server/console-log answers
// exists:false with `refusal` ({ error, code }). The page said "Server
// console log not found / Make sure the server is running", which sent the
// operator to start a server that may well be running. It says why now,
// with what to set.

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
    serverApi: { ...actual.serverApi, getConsoleLog: vi.fn(), streamConsoleLog: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    rconApi: { ...actual.rconApi, getHistory: vi.fn() },
  }
})

const activeServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: 'C:/servers/ashenwood',
  zomboidDataPath: 'C:/Users/someone',
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

function renderConsole() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockReset().mockResolvedValue({ servers: [activeServer] })
  vi.mocked(rconApi.getHistory).mockReset().mockResolvedValue({ history: [] })
  vi.mocked(serverApi.streamConsoleLog).mockReset().mockResolvedValue({ newLines: [], exists: false })
})

describe("Console -- the server log says why the panel won't read it", () => {
  it('shows the data folder refusal, not "not found"', async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({
      success: true,
      lines: [],
      exists: false,
      refusal: { error: 'raw server text', code: 'ZOMBOID_DATA_FOLDER_REFUSED' },
    })
    renderConsole()
    expect(await screen.findByText(enConsole.serverLog.unavailableTitle)).toBeInTheDocument()
    expect(screen.getByText(enErrors.ZOMBOID_DATA_FOLDER_REFUSED)).toBeInTheDocument()
    expect(screen.queryByText(enConsole.serverLog.notFoundTitle)).not.toBeInTheDocument()
  })

  // Verifier round 2: with no data folder set the refusal was
  // SERVER_DATA_PATH_NOT_CONFIGURED, shown as "Server data path not
  // configured" -- not where to set it. Its own code's text says.
  it('says where to set a data folder when the server has none', async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({
      success: true,
      lines: [],
      exists: false,
      refusal: { error: 'raw server text', code: 'SERVER_CONSOLE_LOG_NO_DATA_FOLDER' },
    })
    renderConsole()
    expect(await screen.findByText(enConsole.serverLog.unavailableTitle)).toBeInTheDocument()
    const shown = screen.getByText(/My Servers page/)
    expect(shown.textContent).toBe(enErrors.SERVER_CONSOLE_LOG_NO_DATA_FOLDER)
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument()
  })

  it('still says "not found" when there is simply no log yet', async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({ success: true, lines: [], exists: false })
    renderConsole()
    expect(await screen.findByText(enConsole.serverLog.notFoundTitle)).toBeInTheDocument()
    expect(screen.queryByText(enConsole.serverLog.unavailableTitle)).not.toBeInTheDocument()
  })
})
