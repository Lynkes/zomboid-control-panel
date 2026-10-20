import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// UX restructure (2026-10-20): the Players page keeps its state in the URL.
// ?list= picks the roster card's list (online, roster, banned, whitelist,
// activity) and ?player= the selected player, both read on load and written
// back (replace) as the operator works, so a reload, Back or a link from the
// World Map, Chat or the Leaderboard lands on the same view. Also: on a phone
// a roster pick scrolls the player card into view, the summary's banned
// count opens the Banned list, an unsaved admin note guards the page, and a
// bridge-offline notice links to the fix.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      getPlayerDetails: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

// The Character tab reads the selected player through its own client; a
// stub keeps these tests off the network.
vi.mock('@/lib/characterApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/characterApi')>('@/lib/characterApi')
  return { ...actual, getCharacterSheet: vi.fn(() => new Promise(() => {})) }
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

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

// Stands in for a link from another page (the Leaderboard, Chat) followed
// while the Players page is already open.
function GoTo({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(to)}>go</button>
}

function renderPlayers(initialEntry = '/players', goTo?: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TooltipProvider>
        <Players />
        <LocationProbe />
        {goTo && <GoTo to={goTo} />}
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const search = () => new URLSearchParams(screen.getByTestId('location').textContent!.split('?')[1] ?? '')

function setUpFixtures({ bridgeConnected = true }: { bridgeConnected?: boolean } = {}) {
  getPlayers.mockResolvedValue({ players: [{ name: 'Alice', online: true }, { name: 'Bob', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [{ steamId: '76561198000000002', banned_at: '2026-10-01T10:00:00.000Z' }] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({
    logs: [{ id: 1, player_name: 'Carol', action: 'kick', details: 'Reason: griefing', logged_at: '2026-10-01T10:00:00.000Z' }],
  })
  getStatus.mockResolvedValue({ modConnected: bridgeConnected, isRunning: bridgeConnected } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

function rosterRow(name: string) {
  return within(screen.getByRole('tabpanel', { name: /^Online/ })).getByText(name)
}

beforeEach(() => {
  mockCan = () => true
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Players.tsx: ?list= picks the roster list', () => {
  it('opens the list named in the URL', async () => {
    setUpFixtures()
    renderPlayers('/players?list=banned')
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Banned/ })).toHaveAttribute('aria-selected', 'true'))
    expect(await screen.findByText('76561198000000002')).toBeInTheDocument()
  })

  it('an unknown ?list= falls back to Online', async () => {
    setUpFixtures()
    renderPlayers('/players?list=bogus')
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Online/ })).toHaveAttribute('aria-selected', 'true'))
  })

  it('writes the list back when the operator switches, keeping ?player=', async () => {
    setUpFixtures()
    renderPlayers('/players?player=Alice')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Whitelist/ }), { button: 0 })
    await waitFor(() => expect(search().get('list')).toBe('whitelist'))
    expect(search().get('player')).toBe('Alice')
  })

  it('the summary\'s banned count opens the Banned list', async () => {
    setUpFixtures()
    renderPlayers()
    fireEvent.click(await screen.findByRole('button', { name: 'View 1 banned SteamIDs' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Banned/ })).toHaveAttribute('aria-selected', 'true'))
    expect(search().get('list')).toBe('banned')
  })
})

describe('Players.tsx: ?player= follows the selection', () => {
  it('a roster pick writes ?player=, and picking another player replaces it', async () => {
    setUpFixtures()
    renderPlayers()
    await waitFor(() => expect(rosterRow('Alice')).toBeInTheDocument(), { timeout: 3000 })
    expect(search().get('player')).toBeNull()

    fireEvent.click(rosterRow('Alice'))
    await waitFor(() => expect(search().get('player')).toBe('Alice'))
    expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument()

    fireEvent.click(rosterRow('Bob'))
    await waitFor(() => expect(search().get('player')).toBe('Bob'))
    expect(screen.getByRole('heading', { name: 'Bob' })).toBeInTheDocument()
  })

  it('a link followed while the page is open selects the linked player', async () => {
    setUpFixtures()
    renderPlayers('/players?player=Alice', '/players?player=Bob')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bob' })).toBeInTheDocument())
  })

  it('a name typed in the manual box is written once the typing settles, not per keystroke, and is not pulled back to the old one', async () => {
    setUpFixtures()
    renderPlayers('/players?player=Alice')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument(), { timeout: 3000 })
    const input = screen.getByLabelText('Manual target')
    fireEvent.change(input, { target: { value: 'Da' } })
    fireEvent.change(input, { target: { value: 'Dave' } })
    // Mid-typing: the URL still names Alice, and the box keeps what was typed.
    expect(search().get('player')).toBe('Alice')
    expect(input).toHaveValue('Dave')
    await waitFor(() => expect(search().get('player')).toBe('Dave'))
    expect(input).toHaveValue('Dave')
  })

  it('an Activity row opens that player', async () => {
    setUpFixtures()
    renderPlayers('/players?list=activity')
    fireEvent.click(await screen.findByText('Carol'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Carol' })).toBeInTheDocument())
    expect(search().get('player')).toBe('Carol')
  })
})

describe('Players.tsx: on a phone a roster pick brings the player card into view', () => {
  function stubMatchMedia(phone: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width') ? phone : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }))
  }

  it('scrolls the player card into view below lg', async () => {
    stubMatchMedia(true)
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    setUpFixtures()
    renderPlayers()
    await waitFor(() => expect(rosterRow('Alice')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(rosterRow('Alice'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    const card = scrollIntoView.mock.contexts[0] as HTMLElement
    expect(within(card).getByRole('heading', { name: 'Alice' })).toBeInTheDocument()
  })

  it('leaves the page where it is from lg up, where the card sits beside the list', async () => {
    stubMatchMedia(false)
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    setUpFixtures()
    renderPlayers()
    await waitFor(() => expect(rosterRow('Alice')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(rosterRow('Alice'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('Players.tsx: an unsaved admin note guards the page', () => {
  const leaveAsked = () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('asks before the page is left while a typed note is unsaved', async () => {
    setUpFixtures()
    renderPlayers('/players?player=Alice&tab=notes')
    const note = await screen.findByPlaceholderText('Add notes about this player...', {}, { timeout: 3000 })
    expect(leaveAsked()).toBe(false)
    fireEvent.change(note, { target: { value: 'Owes the base a generator' } })
    await waitFor(() => expect(leaveAsked()).toBe(true))
    fireEvent.change(note, { target: { value: '' } })
    await waitFor(() => expect(leaveAsked()).toBe(false))
  })
})

describe('Players.tsx: a bridge that is offline says where to fix it', () => {
  it('links to Settings › PanelBridge for a role with GM tools', async () => {
    setUpFixtures({ bridgeConnected: false })
    renderPlayers()
    const alert = await screen.findByText('PanelBridge is not connected')
    const box = alert.closest('[role="status"]') as HTMLElement
    expect(within(box).getByRole('link', { name: 'Set up PanelBridge' })).toHaveAttribute('href', '/settings?tab=bridge')
  })

  it('stays quiet for a role that could not use what the bridge powers', async () => {
    mockCan = (capability) => capability !== 'players.gm_tools'
    setUpFixtures({ bridgeConnected: false })
    renderPlayers()
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.queryByText('PanelBridge is not connected')).not.toBeInTheDocument()
  })
})
