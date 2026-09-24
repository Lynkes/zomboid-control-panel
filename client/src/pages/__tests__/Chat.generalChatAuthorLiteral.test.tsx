import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import i18n from '@/i18n'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 21, UX follow-up): sendMessage()'s 'general'
// branch sends the literal English "Admin" to PZ as the author of a
// general-chat post (panelBridgeApi.sendToGeneralChat's second argument --
// PZ has no concept of translating an author name, it echoes back exactly
// what it was given) -- but the panel's own local echo used to label that
// same message with t('labels.admin'), a TRANSLATED word, so a non-English
// operator saw their own post attributed to a name no real player would
// ever actually see in-game. This only shows up under a non-English
// locale: in English the literal and translated strings are identical, so
// a test that never changes i18n.language cannot tell a real fix from a
// no-op. zh-CN's labels.admin ("管理员") is unrelated in spelling to the
// literal "Admin", making it a clean discriminator.

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
      <select
        aria-label={findAriaLabel(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
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

const getPlayers = vi.mocked(playersApi.getPlayers)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const sendToGeneralChat = vi.mocked(panelBridgeApi.sendToGeneralChat)
const getChatInfo = vi.mocked(panelBridgeApi.getChatInfo)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  void i18n.changeLanguage('en')
})

function renderChat() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Chat />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

async function setUp() {
  getPlayers.mockResolvedValue({ players: [] } as Awaited<ReturnType<typeof playersApi.getPlayers>>)
  // An empty chatPresets array here triggers an unrelated pre-existing hang
  // in Chat.tsx's own preset-selection effect (reproduces identically on
  // the untouched 'admin' channel, in plain English, independent of this
  // fix or of i18n) -- not this task's bug, out of scope to fix here, but a
  // non-empty array sidesteps it so this test can actually exercise the
  // literal-vs-translated-author fix.
  getAppSettings.mockResolvedValue({ chatPresets: ['Test preset'] } as unknown as Awaited<ReturnType<typeof configApi.getAppSettings>>)
  getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)
  sendToGeneralChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToGeneralChat>>)
}

describe('Chat.tsx: the general-chat local echo shows the literal author PZ actually receives, not a translated word', () => {
  it('shows "Admin" verbatim in the panel echo under a non-English locale, matching what sendToGeneralChat actually sent', async () => {
    void i18n.changeLanguage('zh-CN')
    await setUp()

    renderChat()

    fireEvent.change(screen.getByRole('combobox', { name: '聊天频道' }), { target: { value: 'general' } })
    const input = await screen.findByRole('textbox', { name: '聊天消息' })
    fireEvent.change(input, { target: { value: 'hello from the panel' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToGeneralChat).toHaveBeenCalledWith('hello from the panel', 'Admin'))
    // The literal author PZ actually received must be what the panel shows
    // for this exact message, not zh-CN's translated word for "admin".
    await screen.findByText('Admin')
    expect(screen.queryByText('管理员')).not.toBeInTheDocument()
  })
})
