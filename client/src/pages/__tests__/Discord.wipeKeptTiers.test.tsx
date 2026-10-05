import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// Security sweep 2026-10-05, D1: POST /discord/reset now keeps the tier of
// every command whose capability the caller doesn't hold (it used to put
// every tier back to its default) and returns those commands in
// keptCommandPermissions. The wipe dialog promised "clears ... command
// permissions", which is no longer true for those; it now says which tiers
// stay, and the message after the wipe names the commands that kept theirs.

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

async function renderConfiguredBot() {
  getStatus.mockResolvedValue({ running: true, configured: true })
  getConfig.mockResolvedValue({
    token: null,
    hasToken: true,
    guildId: '123456789012345678',
    adminRoleId: '',
    modRoleId: '',
    channelId: '234567890123456789',
    autoStart: true,
    chatRelayEnabled: true,
    chatRelayChannelId: '',
    chatRelayScope: 'public',
  })
  getWebhookEvents.mockResolvedValue({ events: {} })
  getPermissions.mockResolvedValue({ permissions: {} })
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())
}

async function wipe() {
  fireEvent.click(screen.getByRole('button', { name: 'Wipe Discord Setup' }))
  const dialog = await screen.findByRole('alertdialog')
  const description = dialog.textContent
  fireEvent.click(within(dialog).getByRole('button', { name: 'Wipe Discord Settings' }))
  await waitFor(() => expect(resetConfig).toHaveBeenCalledTimes(1))
  return description
}

describe('Discord.tsx: wiping keeps the tiers the user cannot change', () => {
  it("the confirm dialog says tiers needing a permission you don't hold are kept", async () => {
    resetConfig.mockResolvedValue({ success: true, keptCommandPermissions: [] })
    await renderConfiguredBot()

    const description = await wipe()

    expect(description).toContain(
      "A command that needs a permission you don't hold in this panel keeps its current tier.",
    )
    expect(description).not.toContain('command permissions,')
  })

  it('names the commands whose tier the wipe kept', async () => {
    resetConfig.mockResolvedValue({ success: true, keptCommandPermissions: ['kick', 'rcon'] })
    await renderConfiguredBot()

    await wipe()

    expect(
      await screen.findByText(
        "Discord bot settings wiped. These commands kept their permission tier because they need permissions you don't hold in this panel: /kick, /rcon",
      ),
    ).toBeInTheDocument()
  })

  it('keeps the plain message when no tier was kept', async () => {
    resetConfig.mockResolvedValue({ success: true, keptCommandPermissions: [] })
    await renderConfiguredBot()

    await wipe()

    expect(
      await screen.findByText('Discord bot settings wiped. You can start setup from scratch.'),
    ).toBeInTheDocument()
  })
})
