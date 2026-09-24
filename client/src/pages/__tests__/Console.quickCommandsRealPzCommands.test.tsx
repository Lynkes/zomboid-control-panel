import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-09-18 (console page hunt): the Quick Commands row offered
// "Server Info" (`serverinfo`) and "Get Memory" (`getmemory`). Neither is a
// command the Project Zomboid server registers -- checked with javap against
// D:/pz-verify/server/java/projectzomboid.jar: every RCON command is a class
// under zombie/commands/serverCommands carrying @CommandName, and no class
// declares either name -- so both buttons could only ever fill the box with
// something PZ rejects. Every quick button must fill a real command.

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
    rconApi: { ...actual.rconApi, execute: vi.fn(), getHistory: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

// @CommandName values from projectzomboid.jar (zombie.commands.serverCommands.*),
// the subset a quick button could plausibly name.
const REAL_PZ_COMMANDS = new Set([
  'players', 'save', 'showoptions', 'checkModsNeedUpdate', 'help', 'connections', 'list',
  'stats', 'reloadoptions', 'quit', 'servermsg',
])

const server: ServerInstance = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '', zomboidDataPath: null,
  serverConfigPath: null, rconHost: '10.0.0.5', rconPort: 27015, rconPassword: 'hunter2',
  serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
  isRemote: false, isActive: true, startCommand: '', adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Console.tsx: quick command buttons only fill commands PZ really has', () => {
  it('has no Server Info / Get Memory buttons, and every quick button fills a real PZ command', async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
    vi.mocked(rconApi.getHistory).mockResolvedValue({ history: [] })
    vi.mocked(configApi.testRcon).mockResolvedValue({ success: true, connected: true })

    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>,
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /rcon console/i }), { button: 0 })

    const input = (await screen.findByLabelText(/rcon command input/i)) as HTMLInputElement
    // The quick row is the buttons between the "quick" label and the command box.
    const label = await screen.findByText(/^quick$/i)
    const buttons = Array.from(label.parentElement!.querySelectorAll('button')).filter(
      (b) => b.textContent && b.textContent.trim().length > 0,
    )
    expect(buttons.length).toBeGreaterThan(0)

    expect(screen.queryByRole('button', { name: /server info/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get memory/i })).not.toBeInTheDocument()

    for (const button of buttons) {
      fireEvent.click(button)
      expect(REAL_PZ_COMMANDS.has(input.value), `"${button.textContent}" filled "${input.value}"`).toBe(true)
    }
  })
})
