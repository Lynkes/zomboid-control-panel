import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// The page's one Save (the SaveBar) shows once a form has an edit.
const editKickTier = () => {
  const kickRow = screen.getByText('/kick').closest('.rounded-lg') as HTMLElement
  fireEvent.click(within(kickRow).getByRole('button', { name: /Everyone/ }))
}
const editAutoStart = () => fireEvent.click(screen.getByRole('switch', { name: /Auto-start on panel launch/ }))

describe('Discord.tsx: saving command permissions', () => {
  it('shows a warning, not "re-registered", when Discord did not take the slash command update', async () => {
    await renderPage()
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: true, permissions: { kick: 'admin' }, commandsRegistered: false }),
    )

    editKickTier()
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(await screen.findByText(/updating the slash commands in Discord failed/)).toBeInTheDocument()
    expect(screen.getByText('Warning')).toBeInTheDocument()
    expect(screen.queryByText(/Slash commands re-registered/)).not.toBeInTheDocument()
  })

  it('says the commands were re-registered when they were', async () => {
    await renderPage()
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, permissions: { kick: 'admin' } }))

    editKickTier()
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(await screen.findByText(/Slash commands re-registered/)).toBeInTheDocument()
    expect(screen.queryByText('Warning')).not.toBeInTheDocument()
  })
})

describe('Discord.tsx: saving the bot configuration', () => {
  const clickSave = () => {
    editAutoStart()
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  }

  it('warns, naming the error, when the saved settings could not reconnect the bot', async () => {
    await renderPage()
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        success: true,
        message: 'Discord bot configuration saved, but the bot failed to reconnect.',
        botStarted: false,
        botStartError: 'Invalid token. Check the token below and save again.',
      }),
    )

    clickSave()

    expect(
      await screen.findByText(
        'Configuration saved, but the bot could not reconnect with it: Invalid token. Check the token below and save again.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Warning')).toBeInTheDocument()
    expect(screen.queryByText('Discord configuration saved successfully')).not.toBeInTheDocument()
  })

  it('still reports a plain success when no reconnect was needed', async () => {
    await renderPage()
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, message: 'Discord bot configuration updated' }))

    clickSave()

    expect(await screen.findByText('Discord configuration saved successfully')).toBeInTheDocument()
    expect(screen.queryByText('Warning')).not.toBeInTheDocument()
  })
})

describe('Discord.tsx: event message templates', () => {
  it('stops at the 500 characters the server keeps', async () => {
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
    getWebhookEvents.mockResolvedValue({ events: { playerJoin: { enabled: true, template: '{player} joined' } } })
    getPermissions.mockResolvedValue({ permissions: {} })
    render(
      <TooltipProvider>
        <ConfirmProvider>
          <Discord />
        </ConfirmProvider>
      </TooltipProvider>,
    )

    const field = await waitFor(() => {
      const el = document.getElementById('template-playerJoin')
      expect(el).not.toBeNull()
      return el as HTMLTextAreaElement
    })

    expect(field.maxLength).toBe(500)
  })
})
