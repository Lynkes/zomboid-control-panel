import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// UX restructure (slice D): the page header carries the bot's state
// (StatusPill) and one contextual primary (Start when stopped, Stop when
// running); the three forms (configuration, event notifications, command
// permissions) share one SaveBar that only shows with unsaved edits; and the
// setup guide can be reopened on a bot that is already set up.

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
    discordApi: {
      ...actual.discordApi,
      getStatus: vi.fn(),
      getConfig: vi.fn(),
      getWebhookEvents: vi.fn(),
      getPermissions: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      updateConfig: vi.fn(),
      updateWebhookEvents: vi.fn(),
      updatePermissions: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(discordApi.getStatus)
const getConfig = vi.mocked(discordApi.getConfig)
const getWebhookEvents = vi.mocked(discordApi.getWebhookEvents)
const getPermissions = vi.mocked(discordApi.getPermissions)
const start = vi.mocked(discordApi.start)
const updateConfig = vi.mocked(discordApi.updateConfig)
const updateWebhookEvents = vi.mocked(discordApi.updateWebhookEvents)
const updatePermissions = vi.mocked(discordApi.updatePermissions)

const CONFIG = {
  token: null,
  hasToken: true,
  guildId: '123456789012345678',
  adminRoleId: '',
  modRoleId: '',
  channelId: '234567890123456789',
  autoStart: true,
  chatRelayEnabled: true,
  chatRelayChannelId: '',
  chatRelayScope: 'public' as const,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderBot(running: boolean) {
  getStatus.mockResolvedValue({ running, configured: true })
  getConfig.mockResolvedValue(CONFIG)
  getWebhookEvents.mockResolvedValue({ events: {} })
  getPermissions.mockResolvedValue({ permissions: {} })
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
  await screen.findByRole('heading', { name: 'Bot Status' })
}

const header = () => screen.getByRole('heading', { level: 1 }).closest('section') as HTMLElement

describe('Discord header: state and one contextual primary', () => {
  it('a stopped bot shows "Stopped" and Start Bot as the primary, with no Stop', async () => {
    await renderBot(false)
    expect(screen.getByRole('heading', { level: 1, name: 'Discord' })).toBeInTheDocument()
    expect(within(header()).getByText('Stopped')).toBeInTheDocument()
    const startButton = within(header()).getByRole('button', { name: 'Start Bot' })
    expect(startButton).toHaveAttribute('data-variant', 'command')
    expect(screen.queryByRole('button', { name: 'Stop Bot' })).not.toBeInTheDocument()

    fireEvent.click(startButton)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  })

  it('a running bot shows "Running" and Stop Bot as the primary, with no Start', async () => {
    await renderBot(true)
    expect(within(header()).getByText('Running')).toBeInTheDocument()
    expect(within(header()).getByRole('button', { name: 'Stop Bot' })).toHaveAttribute('data-variant', 'command')
    expect(screen.queryByRole('button', { name: 'Start Bot' })).not.toBeInTheDocument()
  })
})

describe('Discord SaveBar: one save for the three forms', () => {
  it('shows nothing until a form has an edit, and Discard puts it back', async () => {
    await renderBot(true)
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()

    const channel = screen.getByLabelText(/Notification \/ Chat Channel/)
    fireEvent.change(channel, { target: { value: '345678901234567890' } })
    expect(screen.getByRole('button', { name: 'Save Changes' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(channel).toHaveValue(CONFIG.channelId)
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()
  })

  it('says why Save is blocked while a typed ID is malformed, and never sends it', async () => {
    await renderBot(true)
    fireEvent.change(screen.getByLabelText(/Notification \/ Chat Channel/), { target: { value: '12' } })

    const save = screen.getByRole('button', { name: 'Save Changes' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('saves every edited form at once', async () => {
    updateConfig.mockResolvedValue({ success: true })
    updateWebhookEvents.mockResolvedValue({ success: true })
    updatePermissions.mockResolvedValue({ success: true })
    await renderBot(true)

    fireEvent.click(screen.getByRole('switch', { name: 'Player Join' }))
    const kickRow = screen.getByText('/kick').closest('.rounded-lg') as HTMLElement
    fireEvent.click(within(kickRow).getByRole('button', { name: /Everyone/ }))
    fireEvent.click(screen.getByRole('switch', { name: /Auto-start on panel launch/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
    expect(updateWebhookEvents).toHaveBeenCalledWith(
      expect.objectContaining({ playerJoin: expect.objectContaining({ enabled: true }) }),
    )
    expect(updatePermissions).toHaveBeenCalledWith(expect.objectContaining({ kick: 'everyone' }))
    expect(updateConfig.mock.calls[0][4]).toBe(false)
  })

  it('a configuration save that fails keeps what was typed, while the events that saved reload', async () => {
    updateConfig.mockRejectedValue(new Error('Failed to save configuration'))
    updateWebhookEvents.mockResolvedValue({ success: true })
    await renderBot(true)

    fireEvent.click(screen.getByRole('switch', { name: 'Player Join' }))
    const channel = screen.getByLabelText(/Notification \/ Chat Channel/)
    fireEvent.change(channel, { target: { value: '345678901234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Failed to save configuration')).toBeInTheDocument()
    expect(updateWebhookEvents).toHaveBeenCalledTimes(1)
    expect(channel).toHaveValue('345678901234567890')
    // Still unsaved: the SaveBar stays to try again.
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument()
  })
})

describe('Discord setup guide', () => {
  it('reopens on a bot that is set up, skips re-verifying the saved token, and goes back', async () => {
    await renderBot(true)

    fireEvent.click(screen.getByRole('button', { name: 'Setup guide' }))

    expect(await screen.findByText('Discord Bot Setup')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Bot Status' })).not.toBeInTheDocument()
    // The saved token stands in for Verify: the steps after it are open.
    expect(screen.getByRole('button', { name: /Server IDs/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to bot settings' }))
    expect(await screen.findByRole('heading', { name: 'Bot Status' })).toBeInTheDocument()
  })
})
