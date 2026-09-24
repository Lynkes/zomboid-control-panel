import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { Toaster } from '@/components/ui/toaster'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi, ApiError } from '@/lib/api'
import en from '../../locales/en/players.json'

// continuous-bug-hunt round 29 (card: guard-against-removing-last-admin):
// server/routes/players.js's POST /access-level now returns 409 +
// PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM instead of silently demoting a
// local server's only 'admin' account (server-side coverage:
// playersLastAdminAccessLevelGuard.test.js). This proves the client side of
// that contract: the first rejection surfaces as a confirm dialog naming
// the player, not a bare error toast, and accepting it resubmits with
// confirm: true rather than silently doing nothing or silently retrying.

// Same Select stub shape as Chat.generalChatAuthorLiteral.test.tsx's own
// @/components/ui/select mock -- Radix's real Select needs a ResizeObserver/
// portal environment jsdom doesn't provide, so every test file that drives
// one replaces it with a plain <select> wired to the same value/
// onValueChange contract. This version resolves the native <select>'s id
// from ANY descendant with an `id` prop (SelectTrigger here) so
// <Label htmlFor="access-level"> still resolves it via getByLabelText.
vi.mock('@/components/ui/select', () => {
  function findId(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (found || !React.isValidElement(child)) return
      const props = child.props as { id?: string; children?: React.ReactNode }
      if (props.id) {
        found = props.id
        return
      }
      found = findId(props.children)
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
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    return (
      <select id={findId(children)} value={value} onChange={(e) => onValueChange(e.target.value)}>
        <option value="" disabled></option>
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
    playersApi: {
      ...actual.playersApi,
      getPlayers: vi.fn(),
      getWhitelist: vi.fn(),
      getPerks: vi.fn(),
      getAccessLevels: vi.fn(),
      getSteamIdBans: vi.fn(),
      getNotes: vi.fn(),
      getStats: vi.fn(),
      getExports: vi.fn(),
      getActivityLogs: vi.fn(),
      setAccessLevel: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const setAccessLevel = vi.mocked(playersApi.setAccessLevel)

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
          <Toaster />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({
    success: true,
    available: true,
    accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'admin', authType: 0, steamId: null, ownerId: null, displayName: null }],
    allowedSteamIds: [],
  })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

async function openAccessLevelDialog() {
  fireEvent.click(screen.getByText(en.actionTiles.accessLevelLabel).closest('button')!)
  return screen.findByRole('dialog')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: setting access level confirms before demoting the last admin', () => {
  it('shows a confirm dialog naming the player on the 409, and resubmits with confirm: true when accepted', async () => {
    await setUpFixtures()
    setAccessLevel.mockRejectedValueOnce(
      new ApiError('TestPlayer is the only account with the admin access level.', {
        status: 409,
        code: 'PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM',
      }),
    )
    setAccessLevel.mockResolvedValueOnce({ success: true } as Awaited<ReturnType<typeof playersApi.setAccessLevel>>)

    renderPlayers()
    await selectTestPlayer()
    const dialog = await openAccessLevelDialog()

    fireEvent.change(within(dialog).getByLabelText(en.accessLevelDialog.label), { target: { value: 'moderator' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.accessLevelDialog.submit }))

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(within(confirmDialog).getByText(en.confirmLastAdmin.title)).toBeInTheDocument()
    expect(
      within(confirmDialog).getByText('TestPlayer is the only account with the admin access level. Removing it will leave nobody with full admin commands in-game until it is granted again from here.'),
    ).toBeInTheDocument()
    expect(setAccessLevel).toHaveBeenCalledTimes(1)
    expect(setAccessLevel).toHaveBeenNthCalledWith(1, 'TestPlayer', 'moderator', false)

    fireEvent.click(within(confirmDialog).getByRole('button', { name: en.confirmLastAdmin.confirm }))

    await waitFor(() => expect(setAccessLevel).toHaveBeenCalledTimes(2))
    expect(setAccessLevel).toHaveBeenNthCalledWith(2, 'TestPlayer', 'moderator', true)
  })

  it('does not resubmit when the confirm dialog is cancelled', async () => {
    await setUpFixtures()
    setAccessLevel.mockRejectedValueOnce(
      new ApiError('TestPlayer is the only account with the admin access level.', {
        status: 409,
        code: 'PLAYERS_LAST_ADMIN_ACCESS_LEVEL_CONFIRM',
      }),
    )

    renderPlayers()
    await selectTestPlayer()
    const dialog = await openAccessLevelDialog()

    fireEvent.change(within(dialog).getByLabelText(en.accessLevelDialog.label), { target: { value: 'moderator' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.accessLevelDialog.submit }))

    const confirmDialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: en.confirmLastAdmin.cancel }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(setAccessLevel).toHaveBeenCalledTimes(1)
  })
})
