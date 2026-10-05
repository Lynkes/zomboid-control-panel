import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// Security sweep 2026-10-05, M1: the save sent `chatRelayChannelId ||
// undefined`, and PUT /discord/config keeps a relay channel it isn't sent,
// so emptying the field never cleared it -- the page said "saved" and the
// relay kept its channel. The page now sends "" (server side, and its
// server.world_events gate, pinned in
// server/tests/discordRelayClearAndGuildSends.test.js). Checked on the
// wire: the real discordApi.updateConfig() with fetch faked.

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
const RELAY_CHANNEL = '334567890123456789'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, message: 'Discord bot configuration updated' })))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function renderWithRelayChannel(chatRelayChannelId: string) {
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
    chatRelayChannelId,
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

// The body of the PUT /discord/config the save sent.
async function savedConfigBody() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/discord/config'))).toBe(true),
  )
  const [, init] = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/discord/config'))!
  expect(init?.method).toBe('PUT')
  return JSON.parse(String(init?.body))
}

describe('Discord.tsx: emptying the relay channel clears it', () => {
  it('sends an empty relay channel, so the server clears the stored one', async () => {
    await renderWithRelayChannel(RELAY_CHANNEL)
    const field = screen.getByLabelText(/Chat Relay Channel/)
    expect(field).toHaveValue(RELAY_CHANNEL)

    fireEvent.change(field, { target: { value: '' } })
    const body = await savedConfigBody()

    expect(body).toHaveProperty('chatRelayChannelId', '')
  })

  it("shows the server's refusal when clearing it needs a capability the caller lacks, instead of reporting it saved", async () => {
    await renderWithRelayChannel(RELAY_CHANNEL)
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          error: "The chat relay posts what people type in its Discord channel in game, which needs server.world_events.",
          code: 'DISCORD_CHAT_RELAY_CAPABILITY_REQUIRED',
          params: { detail: 'server.world_events' },
          missing: ['server.world_events'],
        },
        403,
      ),
    )

    fireEvent.change(screen.getByLabelText(/Chat Relay Channel/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(await screen.findByText(/which needs server\.world_events/)).toBeInTheDocument()
    expect(screen.queryByText('Discord configuration saved successfully')).not.toBeInTheDocument()
  })

  it('legit: an untouched relay channel is resent as stored, and none stays none', async () => {
    await renderWithRelayChannel(RELAY_CHANNEL)
    expect(await savedConfigBody()).toHaveProperty('chatRelayChannelId', RELAY_CHANNEL)

    cleanup()
    vi.mocked(fetch).mockClear()
    await renderWithRelayChannel('')
    expect(await savedConfigBody()).toHaveProperty('chatRelayChannelId', '')
  })
})
