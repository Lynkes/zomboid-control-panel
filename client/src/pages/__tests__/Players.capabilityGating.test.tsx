import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'

// bug-hunt-2026-08-27: Players.tsx had zero client-side capability gating.
// Every mutating action reaches one of TWO distinct server gates --
// players.moderate (kick/ban/whitelist/access-level/notes) and
// players.gm_tools (teleport/spawn items+vehicles/xp/character import-export,
// AND godmode/invisible/noclip/heal -- these route through the generic
// PanelBridge passthrough, POST /panel-bridge/command, gated on
// players.gm_tools alone there per an operator ruling, bug-hunt-2026-08-27;
// see server/routes/panelBridge.js's GM_TOOLS_ONLY_ACTIONS). Kill joined
// the same players.gm_tools gate when wired up killplayer-ui-2026-08-30,
// but via its own dedicated route (not the passthrough) -- see that
// card's comment further down.
// Every trigger is asserted, not just the first found, per the Scheduler.tsx
// restart-now lesson. Since the 2026-10-20 restructure each action has one
// home: Kick and Ban next to the player's name, Access Level and the
// whitelist on the Moderation tab, Teleport in the player's "..." menu, and
// the actions that take any name (Unban, SteamID bans, Voice ban, a new
// whitelist account) in the page header's "More" menu.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
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
      ban: vi.fn(),
      unban: vi.fn(),
      unbanSteamId: vi.fn(),
      banSteamId: vi.fn(),
      voiceBan: vi.fn(),
      addUser: vi.fn(),
      addAllowedSteamId: vi.fn(),
      removeAllowedSteamId: vi.fn(),
      removeFromWhitelist: vi.fn(),
      setAccessLevel: vi.fn(),
      saveNote: vi.fn(),
      deleteNote: vi.fn(),
      teleport: vi.fn(),
      addItem: vi.fn(),
      addVehicle: vi.fn(),
      addXp: vi.fn(),
      getExport: vi.fn(),
      deleteExport: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      exportCharacter: vi.fn(),
      importCharacter: vi.fn(),
      killPlayer: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    // A role without bridge.setup/bridge.diagnostics reads the bridge from
    // the composed server status (lib/bridgeLiveness.ts).
    serversApi: { ...actual.serversApi, getComposedStatus: vi.fn() },
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
const kick = vi.mocked(playersApi.kick)
const ban = vi.mocked(playersApi.ban)
const unban = vi.mocked(playersApi.unban)
const unbanSteamId = vi.mocked(playersApi.unbanSteamId)
const banSteamId = vi.mocked(playersApi.banSteamId)
const voiceBan = vi.mocked(playersApi.voiceBan)
const addUser = vi.mocked(playersApi.addUser)
const addAllowedSteamId = vi.mocked(playersApi.addAllowedSteamId)
const removeAllowedSteamId = vi.mocked(playersApi.removeAllowedSteamId)
const removeFromWhitelist = vi.mocked(playersApi.removeFromWhitelist)
const setAccessLevel = vi.mocked(playersApi.setAccessLevel)
const saveNote = vi.mocked(playersApi.saveNote)
const deleteNote = vi.mocked(playersApi.deleteNote)
const teleport = vi.mocked(playersApi.teleport)
const addItem = vi.mocked(playersApi.addItem)
const addVehicle = vi.mocked(playersApi.addVehicle)
const addXp = vi.mocked(playersApi.addXp)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const killPlayer = vi.mocked(panelBridgeApi.killPlayer)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// ConfirmContext's own default (no Provider) always resolves false, same
// precedent as Mods.capabilityGating.test.tsx's renderModsWithConfirm --
// only Kill needs a real confirm() dialog to click through.
function renderPlayersWithConfirm() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
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
    accounts: [{ id: 1, username: 'TestPlayer', lastConnection: null, role: 'user', authType: 0, steamId: null, ownerId: null, displayName: null }],
    allowedSteamIds: ['76561198000000001'],
  })
  getPerks.mockResolvedValue({ catalog: [{ id: 'Sprinting', label: 'Sprinting', category: 'Combat' }] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [{ steamId: '76561198000000002', banned_at: new Date().toISOString() }] })
  // The row as GET /players/notes sends it: the stored record, which names the
  // player in snake_case `player_name` (server/database/init.js upsertPlayerNote).
  getNotes.mockResolvedValue({ notes: [{ id: 'n1', player_name: 'TestPlayer', note: 'existing note', tags: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockResolvedValue({
    provider: 'native',
    selected: true,
    host: { status: 'running', label: 'Host', detail: null },
    server: { status: 'connected', label: 'RCON', detail: null },
    bridge: { status: 'active', label: 'PanelBridge', detail: null },
    summary: '',
  })
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

// Radix's DropdownMenuTrigger opens on pointerdown, not click (same quirk
// family as TabsTrigger switching on mousedown) -- a plain fireEvent.click
// never dispatches pointerdown, so the menu never opens and a query against
// its content sits at the suite's timeout instead of failing fast. Per
// Dashboard.capabilityGating.test.tsx's openMoreActionsMenu precedent.
async function openMenu(triggerName: string) {
  const trigger = await screen.findByRole('button', { name: triggerName })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}
// The selected player's "..." menu (Teleport, Show on map, Import/Export).
const openMoreActionsMenu = () => openMenu('More player actions')
// The page header's "More" menu: the actions that take any name.
const openHeaderMenu = () => openMenu('More actions')

const HEADER_ITEMS = [/^Add whitelist user…/, /^Unban player…/, /^Unban SteamID…/, /^Voice ban…/, /^Ban SteamID…/]

function openList(name: RegExp) {
  // Radix TabsTrigger switches on mousedown, not click.
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

describe('Players.tsx: capability gating', () => {
  it('disables every gated trigger, and clicking any of them never calls the API, when the role holds none of the three capabilities', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    // Kick and Ban: one trigger each, next to the player's name.
    const kickButtons = screen.getAllByRole('button', { name: /^Kick\b/ })
    expect(kickButtons).toHaveLength(1)
    kickButtons.forEach(b => expect(b).toBeDisabled())
    const banButtons = screen.getAllByRole('button', { name: /^Ban\b/ })
    expect(banButtons).toHaveLength(1)
    banButtons.forEach(b => expect(b).toBeDisabled())

    // Moderation tab -- players.moderate.
    expect(screen.getByRole('button', { name: /^Access Level\b/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Add to Whitelist\b/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Remove from Whitelist\b/ })).toBeDisabled()

    ;[...kickButtons, ...banButtons,
      screen.getByRole('button', { name: /^Access Level\b/ }),
      screen.getByRole('button', { name: /^Add to Whitelist\b/ }),
      screen.getByRole('button', { name: /^Remove from Whitelist\b/ }),
    ].forEach(b => fireEvent.click(b))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // The header's "More" menu -- players.moderate, every item disabled with
    // the reason under its label.
    const headerMenu = await openHeaderMenu()
    for (const name of HEADER_ITEMS) {
      const item = within(headerMenu).getByRole('menuitem', { name })
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(item).toHaveTextContent(/players\.moderate/)
      fireEvent.click(item)
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    expect(kick).not.toHaveBeenCalled()
    expect(ban).not.toHaveBeenCalled()
    expect(setAccessLevel).not.toHaveBeenCalled()
    expect(voiceBan).not.toHaveBeenCalled()
    expect(banSteamId).not.toHaveBeenCalled()
    expect(addUser).not.toHaveBeenCalled()
    expect(unban).not.toHaveBeenCalled()
    expect(unbanSteamId).not.toHaveBeenCalled()
    expect(removeFromWhitelist).not.toHaveBeenCalled()
    fireEvent.keyDown(headerMenu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    // Banned list -- the per-row Unban SteamID button.
    openList(/^Banned/)
    await waitFor(() => expect(screen.getByText('76561198000000002')).toBeInTheDocument(), { timeout: 3000 })
    const bannedRowUnban = screen.getAllByRole('button', { name: 'Unban' }).find(b => b.title?.includes('76561198000000002'))
    expect(bannedRowUnban).toBeDisabled()
    if (bannedRowUnban) fireEvent.click(bannedRowUnban)
    expect(unbanSteamId).not.toHaveBeenCalled()

    // Whitelist list -- Add/Remove allowed SteamID, Remove account.
    openList(/^Whitelist/)
    await waitFor(() => expect(screen.getByPlaceholderText('76561198XXXXXXXXX')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.change(screen.getByPlaceholderText('76561198XXXXXXXXX'), { target: { value: '76561198000000099' } })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addAllowedSteamId).not.toHaveBeenCalled()
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons.length).toBeGreaterThanOrEqual(2)
    removeButtons.forEach(b => expect(b).toBeDisabled())
    removeButtons.forEach(b => fireEvent.click(b))
    expect(removeAllowedSteamId).not.toHaveBeenCalled()
    expect(removeFromWhitelist).not.toHaveBeenCalled()

    // Spawn tab -- players.gm_tools.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: /Give XP/ })).toBeInTheDocument(), { timeout: 3000 })
    const giveItemButton = screen.getByText('Give items').closest('button')
    const spawnVehicleButton = screen.getByText('Spawn vehicles').closest('button')
    expect(giveItemButton).toBeDisabled()
    expect(spawnVehicleButton).toBeDisabled()
    // Give XP is NOT asserted here (bug-hunt-2026-08-27 gating-test audit):
    // it's also gated on !selectedPerk, and no perk is selected in this
    // fixture, so .toBeDisabled() would pass regardless of canGmTools. A real
    // Select pick can't drive it in jsdom either: fireEvent.pointerDown+click
    // on the combobox throws inside @radix-ui/react-select itself
    // (target.hasPointerCapture is not a function, then
    // candidate?.scrollIntoView is not a function) -- genuine missing jsdom
    // APIs. Give XP's canGmTools gate is untested here as a result; the
    // other gm_tools triggers (Teleport, Give Items, Spawn Vehicle) still are.
    if (giveItemButton) fireEvent.click(giveItemButton)
    if (spawnVehicleButton) fireEvent.click(spawnVehicleButton)
    expect(addItem).not.toHaveBeenCalled()
    expect(addVehicle).not.toHaveBeenCalled()

    // Powers tab -- players.gm_tools (see the dedicated split-capability
    // tests below for the bridge.command-is-irrelevant proof).
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    enableButtons.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(sendCommand).not.toHaveBeenCalled()
    // A disabled native <button> never fires onClick, so this proves the
    // click above never even reached the confirm() call that would have
    // opened the typed-confirmation dialog -- not just that killPlayer
    // wasn't invoked after some dialog step.
    expect(screen.queryByText('Kill player')).not.toBeInTheDocument()
    expect(killPlayer).not.toHaveBeenCalled()

    // Notes tab -- players.moderate.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Notes/ }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Note' })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: 'Save Note' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save Note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(saveNote).not.toHaveBeenCalled()
    expect(deleteNote).not.toHaveBeenCalled()

    // Teleport -- players.gm_tools, in the player's "..." menu.
    const playerMenu = await openMoreActionsMenu()
    const teleportItem = within(playerMenu).getByRole('menuitem', { name: 'Teleport…' })
    expect(teleportItem).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(teleportItem)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(teleport).not.toHaveBeenCalled()
  })

  // bug-hunt-2026-08-31: ActionTile is a plain <div> inside the trigger
  // <button>, so its "looks disabled" signal is entirely the threaded
  // `disabled` prop driving opacity-50 -- DisabledReason adds only a hover
  // tooltip, and nothing resets a bare <button> to a dimmed look. Before that
  // fix a role without players.moderate saw these tiles at full opacity while
  // the click was silently swallowed. This targets the visual class
  // directly, since toBeDisabled() above only proves the click gate.
  it('dims the Moderation tiles (not just blocks the click) when a player is selected but the role lacks players.moderate', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    for (const name of [/^Access Level\b/, /^Add to Whitelist\b/, /^Remove from Whitelist\b/]) {
      expect(screen.getByRole('button', { name }).firstElementChild?.className).toContain('opacity-50')
    }
  })

  it('enables gated triggers once the role holds the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    screen.getAllByRole('button', { name: /^Kick\b/ }).forEach(b => expect(b).not.toBeDisabled())
    screen.getAllByRole('button', { name: /^Ban\b/ }).forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: /^Access Level\b/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /^Add to Whitelist\b/ })).not.toBeDisabled()

    const headerMenu = await openHeaderMenu()
    for (const name of HEADER_ITEMS) {
      expect(within(headerMenu).getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled', 'true')
    }
    fireEvent.keyDown(headerMenu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    const playerMenu = await openMoreActionsMenu()
    expect(within(playerMenu).getByRole('menuitem', { name: 'Teleport…' })).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(playerMenu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    screen.getAllByRole('button', { name: 'Enable' }).forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): each trigger is driven
  // through its own real dialog (some two-step, per Ban) to its own mock, not
  // just checked for not.toBeDisabled().
  //
  // NAMED EXCLUSION: Access Level is NOT covered here. Its dialog's picker
  // is a real Radix Select, and fireEvent.pointerDown+click on a Radix
  // Select throws in jsdom (see Give XP above).
  // Kick and Ban both clear the selection on success, which collapses the
  // player card -- kept as their own tests rather than folded into the
  // sequence below.
  it('Kick reaches playersApi.kick when clicked through, holding players.moderate', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.click(screen.getByRole('button', { name: /^Kick\b/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Kick Player' }))
    await waitFor(() => expect(kick).toHaveBeenCalledWith('TestPlayer', ''))
  })

  it('Ban reaches playersApi.ban through its two-step confirm, holding players.moderate', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.click(screen.getByRole('button', { name: /^Ban\b/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Ban' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Ban Player' }))
    await waitFor(() => expect(ban).toHaveBeenCalledWith('TestPlayer', false, ''))
  })

  it('every remaining dialog-driven trigger reaches its own real API when clicked through, holding the matching capability', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    // Voice ban -- username pre-fills from the selected player, nothing to
    // type. voiceBanEnabled defaults true, so the submit button reads "Mute".
    fireEvent.click(within(await openHeaderMenu()).getByRole('menuitem', { name: /^Voice ban…/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mute' }))
    await waitFor(() => expect(voiceBan).toHaveBeenCalledWith('TestPlayer', true))

    // Unban -- the username field is NOT pre-filled (it takes any name).
    fireEvent.click(within(await openHeaderMenu()).getByRole('menuitem', { name: /^Unban player…/ }))
    fireEvent.change(await screen.findByPlaceholderText('Enter username to unban...'), { target: { value: 'TestPlayer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban Player' }))
    await waitFor(() => expect(unban).toHaveBeenCalledWith('TestPlayer'))

    // Unban SteamID -- manual-entry fallback Input (not the Select list).
    fireEvent.click(within(await openHeaderMenu()).getByRole('menuitem', { name: /^Unban SteamID…/ }))
    const unbanSteamIdInput = await screen.findByPlaceholderText('Enter Steam ID to unban...')
    fireEvent.change(unbanSteamIdInput, { target: { value: '76561198000000042' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban SteamID' }))
    await waitFor(() => expect(unbanSteamId).toHaveBeenCalledWith('76561198000000042'))

    // Ban SteamID -- exactly 17 digits required to enable submit.
    fireEvent.click(within(await openHeaderMenu()).getByRole('menuitem', { name: /^Ban SteamID…/ }))
    fireEvent.change(await screen.findByPlaceholderText('76561198XXXXXXXXX'), { target: { value: '76561198000000099' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ban SteamID' }))
    await waitFor(() => expect(banSteamId).toHaveBeenCalledWith('76561198000000099', ''))

    // Add whitelist user -- username required, password optional.
    fireEvent.click(within(await openHeaderMenu()).getByRole('menuitem', { name: /^Add whitelist user…/ }))
    fireEvent.change(await screen.findByPlaceholderText('Enter username...'), { target: { value: 'newmod' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }))
    await waitFor(() => expect(addUser).toHaveBeenCalledWith('newmod', ''))

    // Teleport -- from the player's menu; a quick-location preset fills
    // x/y/z in one click and the target field is pre-filled.
    fireEvent.click(within(await openMoreActionsMenu()).getByRole('menuitem', { name: 'Teleport…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Muldraugh' }))
    fireEvent.click(screen.getByRole('button', { name: 'Teleport' }))
    await waitFor(() => expect(teleport).toHaveBeenCalledWith('TestPlayer', { x: 10500, y: 9700, z: 0 }))
  })

  // Kill needs a real ConfirmProvider (typed-confirmation dialog), unlike
  // every other trigger above.
  it('Kill reaches panelBridgeApi.killPlayer once the target name is typed into the confirm dialog', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayersWithConfirm()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    fireEvent.click(await screen.findByRole('button', { name: 'Kill' }))

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText(/type.*TestPlayer/i), { target: { value: 'TestPlayer' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill player' }))

    await waitFor(() => expect(killPlayer).toHaveBeenCalledWith('TestPlayer'))
  })

  // bug-hunt-2026-08-27, operator ruling (supersedes server commit c3083d5):
  // setGodMode/setInvisible/setNoclip/healPlayer are gated on
  // players.gm_tools ALONE, not "gm_tools AND bridge.command" -- requiring
  // both denied Technician (gm_tools without bridge.command by default) the
  // GM tools it's meant to have. gm_tools alone must be SUFFICIENT, and
  // bridge.command alone must remain insufficient. Kill (killplayer-ui-
  // 2026-08-30) is the same players.gm_tools gate via its own route.
  it('bridge.command alone is not sufficient for the GM-tools four -- players.gm_tools is still required', async () => {
    mockCan = (capability) => capability === 'bridge.command'
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled()
    enableButtons.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(sendCommand).not.toHaveBeenCalled()
    expect(killPlayer).not.toHaveBeenCalled()
  })

  it('players.gm_tools alone is sufficient for the GM-tools four, without bridge.command (Technician regains all four)', async () => {
    mockCan = (capability) => capability === 'players.gm_tools'
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    const enableButtons = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableButtons).toHaveLength(3)
    enableButtons.forEach(b => expect(b).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Heal' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeDisabled()

    // Teleport still reachable too -- confirms gm_tools wasn't accidentally
    // narrowed anywhere else on the page by this change.
    const playerMenu = await openMoreActionsMenu()
    expect(within(playerMenu).getByRole('menuitem', { name: 'Teleport…' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  // bug-hunt-2026-09-08 (gate-not-destination sweep): each of the four
  // reaches sendCommand with its own verb, not just an enabled button.
  it('the GM-tools four each reach sendCommand with their own verb when clicked, holding only players.gm_tools', async () => {
    mockCan = (capability) => capability === 'players.gm_tools'
    await setUpFixtures()
    sendCommand.mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
    renderPlayers()
    await selectTestPlayer()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })

    const [godModeBtn, invisibleBtn, noclipBtn] = screen.getAllByRole('button', { name: 'Enable' })
    fireEvent.click(godModeBtn)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setGodMode', { username: 'TestPlayer', enabled: true }))
    fireEvent.click(invisibleBtn)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setInvisible', { username: 'TestPlayer', enabled: true }))
    fireEvent.click(noclipBtn)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setNoclip', { username: 'TestPlayer', enabled: true }))

    fireEvent.click(screen.getByRole('button', { name: 'Heal' }))
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('healPlayer', { username: 'TestPlayer' }))
  })

  // bug-hunt-2026-08-27: Radix's DropdownMenuItem composes the caller's
  // onClick with its own select handler and runs it UNCONDITIONALLY -- the
  // internal disabled check only guards Radix's own side effect, never the
  // onClick prop. The player menu's gated items carry an explicit
  // `if (!canX) return`; this exercises that guard THROUGH THE UI.
  it('the player "..." menu\'s gated items never act when clicked without the capability, even though Radix runs onClick regardless of disabled', async () => {
    mockCan = () => false
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    await openMoreActionsMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Teleport…' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Import/Export Character' }))
    expect(screen.queryByText('Export Character')).not.toBeInTheDocument()
    expect(teleport).not.toHaveBeenCalled()
  })
})

// UX restructure (2026-10-20): each action has one home. God / Invisible /
// Noclip live on the Powers tab only; the player menu holds what isn't
// moderation (Teleport, Show on map, Import/Export).
describe('Players.tsx: one home per action', () => {
  it('the player menu no longer offers God Mode, Invisible or Noclip; they stay on the Powers tab', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    const menu = await openMoreActionsMenu()
    const items = within(menu).getAllByRole('menuitem').map(item => item.textContent)
    expect(items).toEqual(['Teleport…', 'Show on map', 'Import/Export Character'])
    expect(within(menu).queryByRole('menuitem', { name: /God Mode|Invisible|Noclip/ })).toBeNull()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    expect(await screen.findByText('God Mode')).toBeInTheDocument()
  })

  it('"Show on map" links an online player to the World Map with ?player=', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    const menu = await openMoreActionsMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Show on map' })).toHaveAttribute('href', '/world-map?player=TestPlayer')
  })

  it('the header "More" menu holds the actions that take any name, and nothing else on the page duplicates them', async () => {
    mockCan = () => true
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    for (const label of ['Voice Ban', 'SteamID Ban', 'Add User', 'Unban SteamID']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    const menu = await openHeaderMenu()
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Add whitelist user…',
      'Unban player…',
      'Unban SteamID…',
      'Voice ban…',
      'Ban SteamID…',
    ])
  })
})
