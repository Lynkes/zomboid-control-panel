import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Discord from '../Discord'
import { discordApi } from '@/lib/api'

// Start Bot, Stop Bot and Refresh re-read everything from the server and
// put it in all three forms: a command tier, an event toggle or a channel ID
// changed but not saved yet snapped back to the saved value, and the save
// bar disappeared with it. They now refresh only the forms without unsaved
// edits (the bot's status always).

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
    },
  }
})

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
  vi.mocked(discordApi.getStatus).mockResolvedValue({ running, configured: true })
  vi.mocked(discordApi.getConfig).mockResolvedValue(CONFIG)
  vi.mocked(discordApi.getWebhookEvents).mockResolvedValue({ events: {} })
  vi.mocked(discordApi.getPermissions).mockResolvedValue({ permissions: {} })
  vi.mocked(discordApi.start).mockResolvedValue({ success: true } as never)
  vi.mocked(discordApi.stop).mockResolvedValue({ success: true } as never)
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Discord />
      </ConfirmProvider>
    </TooltipProvider>,
  )
  await screen.findByRole('heading', { name: 'Bot Status' })
}

function editAllThreeForms() {
  fireEvent.click(screen.getByRole('switch', { name: 'Player Join' }))
  const kickRow = screen.getByText('/kick').closest('.rounded-lg') as HTMLElement
  fireEvent.click(within(kickRow).getByRole('button', { name: /Everyone/ }))
  fireEvent.change(screen.getByLabelText(/Notification \/ Chat Channel/), { target: { value: '345678901234567890' } })
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument()
}

function expectEditsKept() {
  expect(screen.getByRole('switch', { name: 'Player Join' })).toBeChecked()
  expect(screen.getByLabelText(/Notification \/ Chat Channel/)).toHaveValue('345678901234567890')
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument()
}

describe('Discord: Start, Stop and Refresh keep unsaved edits', () => {
  it('Start Bot', async () => {
    await renderBot(false)
    editAllThreeForms()
    vi.mocked(discordApi.getStatus).mockResolvedValue({ running: true, configured: true })
    fireEvent.click(screen.getByRole('button', { name: 'Start Bot' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeInTheDocument())
    expectEditsKept()
  })

  it('Stop Bot', async () => {
    await renderBot(true)
    editAllThreeForms()
    vi.mocked(discordApi.getStatus).mockResolvedValue({ running: false, configured: true })
    fireEvent.click(screen.getByRole('button', { name: 'Stop Bot' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Bot' })).toBeInTheDocument())
    expectEditsKept()
  })

  it('Refresh, while a form without edits still takes the server\'s new values', async () => {
    await renderBot(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Player Join' }))
    vi.mocked(discordApi.getConfig).mockResolvedValue({ ...CONFIG, channelId: '456789012345678901' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => expect(screen.getByLabelText(/Notification \/ Chat Channel/)).toHaveValue('456789012345678901'))
    expect(screen.getByRole('switch', { name: 'Player Join' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument()
  })
})
