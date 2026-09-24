import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// console follow-ups (2026-09-18): a raw command typed into the RCON console
// ran the instant Enter was pressed -- `quit`, `banuser`, `kick`,
// `changeoption`, `setaccesslevel` and the like included -- with no chance to
// see which command or which server was about to be hit. Destructive commands
// (names checked with javap against projectzomboid.jar) now ask first, naming
// both; harmless ones (players, save, help ...) still run straight away.

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

async function typeAndRun(commandLine: string) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
  vi.mocked(rconApi.getHistory).mockResolvedValue({ history: [] })
  vi.mocked(rconApi.execute).mockResolvedValue({ success: true, response: 'ok' })
  vi.mocked(configApi.testRcon).mockResolvedValue({ success: true, connected: true })
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /rcon console/i }), { button: 0 })
  const input = await screen.findByLabelText(/rcon command input/i)
  fireEvent.change(input, { target: { value: commandLine } })
  fireEvent.click(screen.getByRole('button', { name: /execute command/i }))
}

describe('Console.tsx: destructive raw RCON commands ask for confirmation', () => {
  it.each([
    ['quit', 'quit'],
    ['banuser "Bob" -ip', 'banuser'],
    ['/KICKUSER Bob', 'kickuser'],
    ['changeoption PVP true', 'changeoption'],
    ['setaccesslevel Bob admin', 'setaccesslevel'],
    ['removeuserfromwhitelist Bob', 'removeuserfromwhitelist'],
  ])('%s: names the command and the server, and does not run until confirmed', async (line, name) => {
    await typeAndRun(line)

    expect(await screen.findByText(`Run "${name}" on Ashenwood?`)).toBeInTheDocument()
    expect(screen.getByText(enConsole.rcon.destructiveConfirmDesc)).toBeInTheDocument()
    expect(rconApi.execute).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: enConsole.rcon.destructiveConfirmButton }))
    await waitFor(() => expect(rconApi.execute).toHaveBeenCalledWith(line))
  })

  it('cancelling the dialog sends nothing and keeps the typed command', async () => {
    await typeAndRun('quit')
    await screen.findByText('Run "quit" on Ashenwood?')

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByText('Run "quit" on Ashenwood?')).not.toBeInTheDocument())

    expect(rconApi.execute).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/rcon command input/i)).toHaveValue('quit')
  })

  it('leaves the dialog out of the way for harmless commands', async () => {
    await typeAndRun('players')

    await waitFor(() => expect(rconApi.execute).toHaveBeenCalledWith('players'))
    expect(screen.queryByText(enConsole.rcon.destructiveConfirmDesc)).not.toBeInTheDocument()
  })
})
