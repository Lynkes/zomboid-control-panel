import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 10, activeServerChanged race sweep continued):
// fetchPlayers runs both on a 15s poll and on activeServerChanged, with no
// guard against the two overlapping -- a poll tick for the server that was
// active a moment ago, still in flight, could resolve AFTER the
// activeServerChanged-triggered call for the NEW server and silently
// overwrite it. Same shape and same shared fix (useRequestGuard) as
// Dashboard.activeServerRaceOrder.test.tsx and Console's own round-8 test.

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
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

// Same stable-identity fake socket as Dashboard/Console's own race tests --
// must not be a fresh object literal per useSocket() call, or every render
// would re-run this page's activeServerChanged effect.
const socketHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function setUpCommon() {
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getBridgeStatus.mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

// "Online" is not a unique string on this page (the roster tab strip has its
// own "Online" tab label) -- scope to the summary strip's card, whose label
// is a <p> (the tab strip's is a <span>), then read the numeric value inside
// that same card.
function onlineSummaryCount(): HTMLElement {
  const label = screen.getAllByText('Online').find((el) => el.tagName === 'P')
  if (!label) throw new Error('Online summary label (a <p>) not found')
  const card = label.closest('div.group')
  if (!card) throw new Error('Online summary label has no div.group ancestor')
  return within(card as HTMLElement).getByText(/^\d+$/)
}

describe('Players.tsx: an older, slower roster response must not overwrite a newer one', () => {
  it('keeps the newer server roster when an earlier in-flight fetch resolves AFTER the activeServerChanged fetch', async () => {
    setUpCommon()

    // Call #1 (mount): resolves normally and fast, no players online.
    getPlayers.mockResolvedValueOnce({ players: [] })
    renderPlayers()
    await waitFor(() => expect(onlineSummaryCount()).toHaveTextContent('0'))
    expect(getPlayers).toHaveBeenCalledTimes(1)

    // Call #2 (a later poll tick, simulated here via the page's own manual
    // Refresh button so the test doesn't need fake timers or a real 15s
    // wait): held open -- stands in for a slow/delayed response for
    // whichever server was active when it was issued.
    let resolveStalePoll: (value: Awaited<ReturnType<typeof playersApi.getPlayers>>) => void = () => {}
    const stalePoll = new Promise<Awaited<ReturnType<typeof playersApi.getPlayers>>>((resolve) => { resolveStalePoll = resolve })
    getPlayers.mockImplementationOnce(() => stalePoll)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /refresh/i })) })
    expect(getPlayers).toHaveBeenCalledTimes(2)

    // Call #3 (activeServerChanged): resolves immediately with the new
    // server's one online player.
    getPlayers.mockImplementationOnce(() => Promise.resolve({ players: [{ name: 'Newcomer', online: true }] }))
    await act(async () => { emitActiveServerChanged() })
    expect(getPlayers).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(onlineSummaryCount()).toHaveTextContent('1'))

    // The stale call #2 finally lands, arriving strictly after call #3's
    // already-applied, newer response.
    await act(async () => { resolveStalePoll({ players: [] }) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently reverts the online count back to 0 even though the newer
    // response already confirmed one player online. Give the (buggy) late
    // apply a tick to land before asserting the negative.
    await act(async () => { await Promise.resolve() })
    expect(onlineSummaryCount()).toHaveTextContent('1')
  })
})

// bug-hunt-2026-09-18 (round: whitelist/access-level/admin accounts): same
// race shape as fetchPlayers above, but fetchWhitelist had NO guard at all
// (playersGuard only ever covered fetchPlayers) -- "stale list after
// switching the active server" was reachable for the whitelist tab exactly
// the way it already wasn't for the online roster. Fixed via a second,
// independent useRequestGuard() instance (whitelistGuard).
describe('Players.tsx: an older, slower whitelist response must not overwrite a newer one', () => {
  it('keeps the newer server whitelist when an earlier in-flight fetch resolves AFTER the activeServerChanged fetch', async () => {
    setUpCommon()

    // Call #1 (mount): resolves normally and fast, with the OLD server's account.
    getWhitelist.mockResolvedValueOnce({ success: true, available: true, accounts: [{ id: 1, username: 'OldUser', role: 'user' }], allowedSteamIds: [] })
    renderPlayers()
    await waitFor(() => expect(getWhitelist).toHaveBeenCalledTimes(1))

    // Switch to the whitelist tab -- itself triggers a second fetch (the
    // tab button's own onClick calls fetchWhitelist()); resolve it with the
    // same OLD-server data so the list is visibly populated before the race.
    getWhitelist.mockResolvedValueOnce({ success: true, available: true, accounts: [{ id: 1, username: 'OldUser', role: 'user' }], allowedSteamIds: [] })
    await act(async () => { fireEvent.click(screen.getByText('Whitelist')) })
    await waitFor(() => expect(screen.getByText('OldUser')).toBeInTheDocument())
    expect(getWhitelist).toHaveBeenCalledTimes(2)

    // Call #3 (a later manual Refresh, simulating a slow response for
    // whichever server was active when it was issued): held open.
    let resolveStaleWhitelist: (value: Awaited<ReturnType<typeof playersApi.getWhitelist>>) => void = () => {}
    const staleWhitelist = new Promise<Awaited<ReturnType<typeof playersApi.getWhitelist>>>((resolve) => { resolveStaleWhitelist = resolve })
    getWhitelist.mockImplementationOnce(() => staleWhitelist)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /refresh/i })) })
    expect(getWhitelist).toHaveBeenCalledTimes(3)

    // Call #4 (activeServerChanged): resolves immediately with the NEW
    // server's whitelist.
    getWhitelist.mockImplementationOnce(() => Promise.resolve({ success: true, available: true, accounts: [{ id: 2, username: 'NewUser', role: 'admin' }], allowedSteamIds: [] }))
    await act(async () => { emitActiveServerChanged() })
    expect(getWhitelist).toHaveBeenCalledTimes(4)
    await waitFor(() => expect(screen.getByText('NewUser')).toBeInTheDocument())

    // The stale call #3 finally lands, arriving strictly after call #4's
    // already-applied, newer response.
    await act(async () => { resolveStaleWhitelist({ success: true, available: true, accounts: [{ id: 1, username: 'OldUser', role: 'user' }], allowedSteamIds: [] }) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently reverts the list back to the OLD server's account even
    // though the newer response already confirmed the new one.
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('NewUser')).toBeInTheDocument()
    expect(screen.queryByText('OldUser')).not.toBeInTheDocument()
  })
})
