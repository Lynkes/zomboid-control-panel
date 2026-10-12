import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// Two saves reported plain success although something did not take:
//  - PUT /discord/permissions stores the tiers, then pushes the slash commands
//    to Discord; when that push fails the server now still answers success
//    with commandsRegistered: false, and the page has to say so.
//  - PUT /discord/config answers botStarted: false (with botStartError) when
//    the new settings were saved but the bot could not reconnect with them.
// Real discordApi over a faked fetch.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)

const GUILD = '123456789012345678'
const CHANNEL = '234567890123456789'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true })))
})

async function renderPage() {
  getStatus.mockResolvedValue({ running: true, configured: true })
  getConfig.mockResolvedValue({
    token: null,
    hasToken: true,
    guildId: GUILD,
    adminRoleId: '',
    modRoleId: '',
    channelId: CHANNEL,
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

describe('Discord.tsx: saving command permissions', () => {
  it('shows a warning, not "re-registered", when Discord did not take the slash command update', async () => {
    await renderPage()
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: true, permissions: { kick: 'admin' }, commandsRegistered: false }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save Permissions' }))

    expect(await screen.findByText(/updating the slash commands in Discord failed/)).toBeInTheDocument()
    expect(screen.getByText('Warning')).toBeInTheDocument()
    expect(screen.queryByText(/Slash commands re-registered/)).not.toBeInTheDocument()
  })

  it('says the commands were re-registered when they were', async () => {
    await renderPage()
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, permissions: { kick: 'admin' } }))

    fireEvent.click(screen.getByRole('button', { name: 'Save Permissions' }))

    expect(await screen.findByText(/Slash commands re-registered/)).toBeInTheDocument()
    expect(screen.queryByText('Warning')).not.toBeInTheDocument()
  })
})
