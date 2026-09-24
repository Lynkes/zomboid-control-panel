import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// bug-hunt-2026-09-18 (console page hunt): the broadcast box built
// `servermsg "<text with " escaped as \">"`. PZ's RCON parser
// (zombie.commands.CommandBase, javap against projectzomboid.jar) tokenizes the
// line with ([^"]\S*|".*?")\s* and then deletes every `"` -- there is no escape
// syntax -- so a message containing a double quote (or a newline typed into the
// textarea) split into several tokens, servermsg's single-argument pattern
// stopped matching, and PZ replied with the command's help text
// ("Broadcast a message to all connected players. Use: /servermsg "My
// Message""). That reply is an ordinary successful RCON response, so the panel
// showed "Broadcast Sent", cleared the draft, and nobody was ever notified.
// The scheduler's announcements already avoid this via
// RconService.sanitizeServerMessage + a help-text check; this page had neither.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const execute = vi.mocked(rconApi.execute)

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

async function openBroadcastAndType(text: string) {
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
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(enConsole.broadcast.toggleLabel, 'i') }))
  const box = await screen.findByLabelText(enConsole.broadcast.messageAria)
  fireEvent.change(box, { target: { value: text } })
  return box as HTMLTextAreaElement
}

const sendButton = () => screen.getByRole('button', { name: new RegExp(`^${enConsole.broadcast.send}$`, 'i') })

describe('Console.tsx: broadcast text is made safe for PZ\'s quote-tokenizing RCON parser', () => {
  it('sends a message with double quotes and a newline as one quoted servermsg argument', async () => {
    execute.mockResolvedValue({ success: true, response: 'Message sent.' })
    await openBroadcastAndType('Restart in 5 "minutes"\nfind a safe spot')

    fireEvent.click(sendButton())

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    // No `"` other than the two wrapping the argument, and no line break.
    expect(execute).toHaveBeenCalledWith('servermsg "Restart in 5 minutes find a safe spot"')
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: enConsole.toasts.broadcastSentTitle })),
    )
  })

  it('does not report success, and keeps the draft, when PZ answers with servermsg\'s help text', async () => {
    execute.mockResolvedValue({
      success: true,
      response: 'Broadcast a message to all connected players. Use: /servermsg "My Message"',
    })
    const box = await openBroadcastAndType('Restart soon')

    fireEvent.click(sendButton())

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enConsole.toasts.errorTitle, description: enConsole.toasts.broadcastFailedFallback }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: enConsole.toasts.broadcastSentTitle }))
    expect(box.value).toBe('Restart soon')
  })

  it('refuses to send a message that is nothing but quotes', async () => {
    await openBroadcastAndType('""')

    fireEvent.click(sendButton())

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: enConsole.toasts.broadcastFailedFallback }),
      ),
    )
    expect(execute).not.toHaveBeenCalled()
  })
})
