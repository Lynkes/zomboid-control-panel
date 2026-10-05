import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// Security sweep 2026-10-05, HT4c: the wipe dialog said the chat relay
// settings are cleared, but POST /discord/reset puts auto-start and the chat
// relay back to their defaults, which are on (discordBot.js resetConfig(),
// pinned in server/tests/discordChatRelayGuildAndCapability.test.js). The
// dialog now says that, in every locale.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'integrator', capabilities: [] },
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
    discordApi: {
      ...actual.discordApi,
      getStatus: vi.fn(),
      getConfig: vi.fn(),
      getWebhookEvents: vi.fn(),
      getPermissions: vi.fn(),
      resetConfig: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)
const resetConfig = vi.mocked(discordApi.resetConfig)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Discord.tsx: the wipe dialog says what happens to auto-start and the chat relay', () => {
  it('says both go back on, rather than that the relay settings are cleared', async () => {
    getStatus.mockResolvedValue({ running: true, configured: true })
    getConfig.mockResolvedValue({
      token: null,
      hasToken: true,
      guildId: '123456789012345678',
      adminRoleId: '',
      modRoleId: '',
      channelId: '234567890123456789',
      autoStart: false,
      chatRelayEnabled: false,
      chatRelayChannelId: '',
      chatRelayScope: 'general',
    })
    getWebhookEvents.mockResolvedValue({ events: {} })
    getPermissions.mockResolvedValue({ permissions: {} })
    resetConfig.mockResolvedValue({ success: true, keptCommandPermissions: [] })
    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Discord />
        </ConfirmProvider>
      </TooltipProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Wipe Discord Setup' }))
    const dialog = await screen.findByRole('alertdialog')
    const description = dialog.textContent ?? ''

    expect(description).not.toContain('chat relay settings')
    expect(description).toContain('chat relay channel')
    expect(description).toContain(
      'Auto-start and the chat relay go back to their defaults, which are on: once a new token is set up, the bot starts with the panel and relays all public chat both ways through the notification channel.',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Wipe Discord Settings' }))
    await waitFor(() => expect(resetConfig).toHaveBeenCalledTimes(1))
  })
})
