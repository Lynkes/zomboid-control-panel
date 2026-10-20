import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// Switching the active server used to refetch the roster, notes, bans,
// whitelist and access levels but left everything else the page holds about
// the previous server in place: the selected player (so the next kick or
// teleport still named them), the GM-power badges kept per player NAME (a
// same-named player on the new server showed the old one's God mode), and the
// per-server activity log. Four of those fetches also had no staleness guard,
// so a slow answer for the old server could land after the new server's.

// Radix's Select renders its options only when opened, which jsdom can't do:
// a plain <select> with the same value/onValueChange contract, so the options
// the page offers are in the DOM (same stub as
// Players.lastAdminAccessLevelConfirm.test.tsx).
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
async function emitActiveServerChanged() {
  await act(async () => {
    socketHandlers.get('activeServerChanged')?.forEach((h) => h())
  })
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
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function setUpCommon() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

function renderPlayers(entry = '/') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const log = (id: number, player: string, action: string) => ({
  id,
  player_name: player,
  action,
  details: null,
  logged_at: '2026-10-09T10:00:00.000Z',
})

describe('Players.tsx: switching the active server drops the previous server\'s player state', () => {
  it('clears the selected player and the God-mode badge a same-named player would otherwise inherit', async () => {
    setUpCommon()
    sendCommand.mockResolvedValue({ success: true, data: { verified: 'confirmed' } } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
    renderPlayers()

    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByText('TestPlayer'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'TestPlayer' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Powers' }), { button: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Heal' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable' })[0])
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setGodMode', { username: 'TestPlayer', enabled: true }))
    const rosterRow = () => screen.getAllByText('TestPlayer').map((el) => el.closest('button')).find((b): b is HTMLButtonElement => !!b && b.className.includes('group'))!
    await waitFor(() => expect(rosterRow().querySelector('.lucide-ghost')).not.toBeNull())

    // The new server also has a player called TestPlayer.
    await emitActiveServerChanged()

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'TestPlayer' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument())
    expect(rosterRow().querySelector('.lucide-ghost')).toBeNull()
    expect(getPlayers.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Players.tsx: the activity log is per server', () => {
  it('refetches the open log on a server switch and ignores the old server\'s late answer', async () => {
    setUpCommon()
    const oldServerLog = deferred<Awaited<ReturnType<typeof playersApi.getActivityLogs>>>()
    getActivityLogs.mockImplementationOnce(() => oldServerLog.promise)
    getActivityLogs.mockResolvedValue({ logs: [log(2, 'ZedFromNewServer', 'ban')] })

    renderPlayers('/?list=activity')
    await waitFor(() => expect(getActivityLogs).toHaveBeenCalledTimes(1))

    await emitActiveServerChanged()
    await waitFor(() => expect(getActivityLogs).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('ZedFromNewServer')).toBeInTheDocument())

    await act(async () => { oldServerLog.resolve({ logs: [log(1, 'AliceFromOldServer', 'kick')] }) })
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByText('AliceFromOldServer')).not.toBeInTheDocument()
    expect(screen.getByText('ZedFromNewServer')).toBeInTheDocument()
  })

  it('empties the old server\'s log at once, and loads the new one when the tab is opened', async () => {
    setUpCommon()
    getActivityLogs.mockResolvedValueOnce({ logs: [log(1, 'AliceFromOldServer', 'kick')] })
    renderPlayers('/?list=activity')
    await waitFor(() => expect(screen.getByText('AliceFromOldServer')).toBeInTheDocument())

    // Another list is open when the switch happens: nothing to refetch yet,
    // but the old rows must not be waiting there when the list is opened.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Online/ }), { button: 0 })
    await emitActiveServerChanged()
    const newServerLog = deferred<Awaited<ReturnType<typeof playersApi.getActivityLogs>>>()
    getActivityLogs.mockImplementation(() => newServerLog.promise)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Activity' }), { button: 0 })

    // The new server's log is still loading: the old rows must not show meanwhile.
    await waitFor(() => expect(getActivityLogs).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('AliceFromOldServer')).not.toBeInTheDocument()
    await act(async () => { newServerLog.resolve({ logs: [log(2, 'ZedFromNewServer', 'ban')] }) })
    await waitFor(() => expect(screen.getByText('ZedFromNewServer')).toBeInTheDocument())
  })
})

describe('Players.tsx: an older answer for the previous server must not overwrite the new server\'s', () => {
  it('keeps the new server\'s SteamID bans when the old server\'s list arrives last', async () => {
    setUpCommon()
    const oldBans = deferred<Awaited<ReturnType<typeof playersApi.getSteamIdBans>>>()
    getSteamIdBans.mockImplementationOnce(() => oldBans.promise)
    getSteamIdBans.mockResolvedValue({ bans: [] })

    renderPlayers()
    await waitFor(() => expect(getSteamIdBans).toHaveBeenCalledTimes(1))
    await emitActiveServerChanged()
    await waitFor(() => expect(getSteamIdBans).toHaveBeenCalledTimes(2))

    await act(async () => { oldBans.resolve({ bans: [{ steamId: '76561198000000001', banned_at: '2026-10-01T10:00:00.000Z' }] }) })
    await act(async () => { await Promise.resolve() })

    // The summary's banned count stays at the new server's 0.
    expect(screen.getByRole('button', { name: 'View 0 banned SteamIDs' })).toBeInTheDocument()
  })

  it('keeps the new server\'s notes and playtime when the old server\'s answer arrives last', async () => {
    setUpCommon()
    const oldStats = deferred<Awaited<ReturnType<typeof playersApi.getStats>>>()
    getStats.mockImplementationOnce(() => oldStats.promise)
    getStats.mockResolvedValue({ stats: [] })

    renderPlayers()
    await waitFor(() => expect(getStats).toHaveBeenCalledTimes(1))
    await emitActiveServerChanged()
    await waitFor(() => expect(getStats).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument())

    await act(async () => {
      oldStats.resolve({
        stats: [{ player_name: 'TestPlayer', total_playtime_seconds: 18000, session_count: 3, first_seen: '2026-09-01T10:00:00.000Z', last_seen: '2026-10-01T10:00:00.000Z' }],
      })
    })
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByText('5h 0m')).not.toBeInTheDocument()
  })

  it('keeps the new server\'s access levels when the old server\'s list arrives last', async () => {
    setUpCommon()
    const oldLevels = deferred<Awaited<ReturnType<typeof playersApi.getAccessLevels>>>()
    getAccessLevels.mockImplementationOnce(() => oldLevels.promise)
    getAccessLevels.mockResolvedValue({ levels: ['newserverrole', 'none'], available: true })

    renderPlayers()
    await waitFor(() => expect(getAccessLevels).toHaveBeenCalledTimes(1))
    await emitActiveServerChanged()
    await waitFor(() => expect(getAccessLevels).toHaveBeenCalledTimes(2))
    await act(async () => { oldLevels.resolve({ levels: ['oldserverrole'], available: true }) })
    await act(async () => { await Promise.resolve() })

    await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument())
    fireEvent.click(screen.getByText('TestPlayer'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'TestPlayer' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getAllByText('Access Level')[0].closest('button')!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('option', { name: 'Newserverrole' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('option', { name: 'Oldserverrole' })).not.toBeInTheDocument()
  })
})
