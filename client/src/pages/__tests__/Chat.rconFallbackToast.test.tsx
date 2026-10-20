import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// POST /panel-bridge/chat/admin falls back to an RCON servermsg "[ADMIN] ..."
// when PanelBridge or the game's chat API isn't there, and answers
// method: "RCON" ("visible to all"). The page ignored that and toasted
// "Visible only to admins in-game" for a message every player had just read.

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/components/ui/select', () => {
  function findAriaLabel(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const label = (child.props as { 'aria-label'?: string })['aria-label']
      if (label) found = label
    })
    return found
  }
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select aria-label={findAriaLabel(children)} value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

Element.prototype.scrollIntoView = vi.fn()

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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendToServerChat: vi.fn(),
      sendToAdminChat: vi.fn(),
      sendToGeneralChat: vi.fn(),
      getChatInfo: vi.fn(),
    },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setUp() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] } as never)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ chatPresets: ['Test preset'] } as never)
  vi.mocked(panelBridgeApi.getChatInfo).mockResolvedValue({ success: true, data: { chatServerAvailable: false, rconFallback: true } })
}

async function send(channel: 'admin' | 'general', text: string) {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Chat />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat channel' }), { target: { value: channel } })
  const input = await screen.findByRole('textbox', { name: 'Chat message' })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('Chat.tsx: a message that went out over RCON says every player saw it', () => {
  it('admin chat sent over RCON warns instead of claiming "admins only"', async () => {
    setUp()
    vi.mocked(panelBridgeApi.sendToAdminChat).mockResolvedValue({
      success: true,
      data: { message: 'Admin message sent via RCON (visible to all)', method: 'RCON' },
    })
    await send('admin', 'ban him next restart')

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const shown = toastSpy.mock.calls.at(-1)![0]
    expect(shown).toMatchObject({ title: 'Sent to every player', variant: 'warning' })
    expect(shown.description).toMatch(/every player sees/)
    expect(JSON.stringify(toastSpy.mock.calls)).not.toContain('Visible only to admins in-game.')
  })

  it('admin chat through the game still says admins only', async () => {
    setUp()
    vi.mocked(panelBridgeApi.sendToAdminChat).mockResolvedValue({ success: true, data: { method: 'ChatServer' } })
    await send('admin', 'hello admins')

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls.at(-1)![0]).toMatchObject({ description: 'Visible only to admins in-game.', variant: 'success' })
  })

  it('general chat sent over RCON says it went out as a server message', async () => {
    setUp()
    vi.mocked(panelBridgeApi.sendToGeneralChat).mockResolvedValue({
      success: true,
      data: { message: 'Message sent via RCON', author: 'Admin', method: 'RCON' },
    })
    await send('general', 'hello all')

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls.at(-1)![0]).toMatchObject({ title: 'Sent to every player', variant: 'warning' })
  })
})
