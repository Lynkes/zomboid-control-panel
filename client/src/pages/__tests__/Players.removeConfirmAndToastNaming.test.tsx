import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { Toaster } from '@/components/ui/toaster'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import en from '../../locales/en/players.json'

// Round-21 UX follow-up (hive continuous-bug-hunt): three gaps on this page.
// (1) "Remove from Whitelist" and "Remove Allowed SteamID" fired the API
// straight from onClick, with no confirmation at all -- every other
// destructive action on this page (Ban, killPlayer, delete-note) confirms
// first. (2) The "Add to Whitelist" dossier item opened the exact same
// dialog as the standalone "Add User" tile, titled "Add User" either way --
// misleading when the operator picked an already-known player to whitelist,
// not create a new account. (3) handleAction's generic success toast never
// named which player it happened to. This file proves: the two new confirm
// dialogs name their target and actually block the API call until
// confirmed; the dialog is retitled per entry point; and a couple of
// representative toasts now name the player.

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
      kick: vi.fn(),
      addUser: vi.fn(),
      removeFromWhitelist: vi.fn(),
      removeAllowedSteamId: vi.fn(),
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
const kick = vi.mocked(playersApi.kick)
const addUser = vi.mocked(playersApi.addUser)
const removeFromWhitelist = vi.mocked(playersApi.removeFromWhitelist)
const removeAllowedSteamId = vi.mocked(playersApi.removeAllowedSteamId)

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

// TestPlayer is online AND already on the whitelist (as its own account),
// and one allowed SteamID is seeded too -- so every "remove" affordance
// under test starts enabled, and the dossier's own "Remove from Whitelist"
// item isn't disabled by isPlayerConfirmedNotWhitelisted (see
// Players.whitelistRemoveDisabledReason.test.tsx).
async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({
    success: true,
    available: true,
    accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'user', authType: 0, steamId: null, ownerId: null, displayName: null }],
    allowedSteamIds: ['76561198000000001'],
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

// Radix's DropdownMenuTrigger opens on pointerdown, not click -- see
// Players.capabilityGating.test.tsx's openMoreActionsMenu, same precedent.
async function openMoreActionsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More player actions' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

async function openWhitelistTab() {
  fireEvent.click(screen.getByText(en.roster.tabWhitelist).closest('button')!)
  await screen.findByTitle(en.roster.removeTitle.replace('{{username}}', 'TestPlayer'))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: "Remove from Whitelist" (whitelist tab list) confirms before removing', () => {
  it('does not call removeFromWhitelist until the confirm dialog naming the account is accepted', async () => {
    await setUpFixtures()
    renderPlayers()
    await openWhitelistTab()

    fireEvent.click(screen.getByTitle(en.roster.removeTitle.replace('{{username}}', 'TestPlayer')))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(en.roster.removeFromWhitelistConfirmTitle)).toBeInTheDocument()
    expect(within(dialog).getByText('TestPlayer will be removed from the whitelist account database.')).toBeInTheDocument()
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle(en.roster.removeTitle.replace('{{username}}', 'TestPlayer')))
    const dialog2 = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog2).getByRole('button', { name: en.roster.removeFromWhitelistConfirmButton }))

    await waitFor(() => expect(removeFromWhitelist).toHaveBeenCalledWith('TestPlayer'))
  })
})

describe('Players.tsx: dossier "Remove from Whitelist" confirms before removing', () => {
  it('does not call removeFromWhitelist until the confirm dialog naming the player is accepted', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await openMoreActionsMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Whitelist' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(en.roster.removeFromWhitelistConfirmTitle)).toBeInTheDocument()
    expect(within(dialog).getByText('TestPlayer will be removed from the whitelist account database.')).toBeInTheDocument()
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: en.roster.removeFromWhitelistConfirmButton }))
    await waitFor(() => expect(removeFromWhitelist).toHaveBeenCalledWith('TestPlayer'))
  })
})

describe('Players.tsx: "Remove Allowed SteamID" confirms before removing', () => {
  it('does not call removeAllowedSteamId until the confirm dialog naming the SteamID is accepted', async () => {
    await setUpFixtures()
    renderPlayers()
    await openWhitelistTab()

    const steamId = '76561198000000001'
    fireEvent.click(screen.getByTitle(en.roster.removeAllowedTitle.replace('{{steamId}}', steamId)))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(en.roster.removeAllowedSteamIdConfirmTitle)).toBeInTheDocument()
    expect(within(dialog).getByText(`${steamId} will no longer be allowed to join a whitelisted server.`)).toBeInTheDocument()
    expect(removeAllowedSteamId).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: en.roster.removeAllowedSteamIdConfirmButton }))
    await waitFor(() => expect(removeAllowedSteamId).toHaveBeenCalledWith(steamId))
  })
})

describe('Players.tsx: the Add User / Add to Whitelist dialog is retitled per entry point', () => {
  it('shows "Add User" from the standalone tile, and "Add to Whitelist" naming the player from the dossier', async () => {
    await setUpFixtures()
    renderPlayers()

    fireEvent.click(screen.getByTitle(en.actionTiles.addUserTooltip))
    const standaloneDialog = await screen.findByRole('dialog')
    expect(within(standaloneDialog).getByRole('heading', { name: en.addUserDialog.title })).toBeInTheDocument()
    fireEvent.click(within(standaloneDialog).getByRole('button', { name: en.addUserDialog.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await selectTestPlayer()
    await openMoreActionsMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Whitelist' }))

    const whitelistDialog = await screen.findByRole('dialog')
    expect(within(whitelistDialog).getByRole('heading', { name: en.addUserDialog.titleWhitelist })).toBeInTheDocument()
    expect(within(whitelistDialog).getByText('Add TestPlayer to the whitelist account database. Build 42 allows an empty password.')).toBeInTheDocument()
    expect(within(whitelistDialog).queryByRole('heading', { name: en.addUserDialog.title })).not.toBeInTheDocument()
  })
})

describe('Players.tsx: success toasts name the target player', () => {
  it('names the player in the Kick success toast', async () => {
    kick.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof playersApi.kick>>)
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    const kickTile = screen.getAllByText(en.dossier.kickButton)
      .map((el) => el.closest('button'))
      .find((btn): btn is HTMLButtonElement => btn !== null)
    if (!kickTile) throw new Error('Kick tile has no <button> ancestor')
    fireEvent.click(kickTile)
    fireEvent.click(await screen.findByRole('button', { name: en.kickDialog.submit }))

    await screen.findByText('Kick player for TestPlayer')
  })

  it('names the player in the Add to Whitelist success toast', async () => {
    addUser.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof playersApi.addUser>>)
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    await openMoreActionsMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Whitelist' }))

    const dialog = await screen.findByRole('dialog')
    within(dialog).getByRole('heading', { name: en.addUserDialog.titleWhitelist })
    fireEvent.click(within(dialog).getByRole('button', { name: en.addUserDialog.submitWhitelist }))

    await screen.findByText('Add user for TestPlayer')
  })
})
