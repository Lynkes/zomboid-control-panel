import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'
import enEvents from '../../locales/en/events.json'

// bug-hunt-2026-09-18 (round 10, activeServerChanged race sweep continued):
// fetchPlayers runs on a 30s poll, on the page's own manual "Refresh
// players" button, AND on activeServerChanged, with no guard against two of
// those overlapping -- a poll/manual call for the server that was active a
// moment ago, still in flight, could resolve AFTER the
// activeServerChanged-triggered call for the NEW server and silently
// overwrite it, reverting the roster to the old server's players with no
// further trigger to self-correct. Same shape as Dashboard.tsx's fix
// (Dashboard.activeServerRaceOrder.test.tsx), via the shared useRequestGuard
// hook (playersGuard in Events.tsx).

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

// bug-hunt-2026-09-18 (round 19): Events.tsx now calls useAuth() to gate
// its players.endanger_or_impersonate-only controls (lightning/thunder/
// horde/targeted sounds) -- default every existing test in this file to a
// fully-permitted role so none of their prior behavior changes.
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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getWeather: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
    },
  }
})

// Same stable-identity fake socket as Dashboard.activeServerRaceOrder.test.tsx
// -- must not be a fresh object literal per useSocket() call, or every
// render would re-run this page's activeServerChanged effect.
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
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const getWeather = vi.mocked(panelBridgeApi.getWeather)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)

function setUpCommon() {
  // modConnected: false keeps checkBridgeStatus() from cascading into
  // getWeather/getClimateFloats/getGameTime/getUtilitiesStatus -- none of
  // those are exercised by this fixture, and this race only concerns
  // fetchPlayers.
  getBridgeStatus.mockResolvedValue({ modConnected: false } as never)
}

function renderEvents() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

// Reaches the "Spawn vehicle" panel's plain (non-Select) player-button list,
// the same always-cheap-to-reach surface Events.playersUnknownVsNone.test.tsx
// uses -- a Radix Select's dropdown content only mounts while open, and real
// pointer interaction on one throws in jsdom.
function openSpawnVehicleSection() {
  fireEvent.click(screen.getByRole('button', { name: enEvents.sections.vehicles.label }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Events.tsx: an older, slower player-list response must not overwrite a newer one', () => {
  it('keeps the newer server\'s roster when an earlier in-flight fetch resolves AFTER the activeServerChanged fetch', async () => {
    setUpCommon()

    // Call #1 (mount): resolves normally and fast, with server A's roster.
    getPlayers.mockResolvedValueOnce({ players: [{ name: 'Alice' }] } as never)
    renderEvents()
    openSpawnVehicleSection()
    await screen.findByText('Alice')
    expect(getPlayers).toHaveBeenCalledTimes(1)

    // Call #2 (a later poll tick, simulated here via the page's own manual
    // "Refresh players" button so the test doesn't need fake timers): held
    // open -- stands in for a slow/delayed response for whichever server was
    // active when it was issued.
    let resolveStalePoll: (value: Awaited<ReturnType<typeof playersApi.getPlayers>>) => void = () => {}
    const stalePoll = new Promise<Awaited<ReturnType<typeof playersApi.getPlayers>>>((resolve) => { resolveStalePoll = resolve })
    getPlayers.mockImplementationOnce(() => stalePoll)
    fireEvent.click(screen.getByRole('button', { name: enEvents.pageHeader.refreshPlayers }))
    expect(getPlayers).toHaveBeenCalledTimes(2)

    // Call #3 (activeServerChanged): resolves immediately with server B's
    // roster -- 'Bob' is the observable signal that this landed.
    getPlayers.mockImplementationOnce(() => Promise.resolve({ players: [{ name: 'Bob' }] } as never))
    await act(async () => { emitActiveServerChanged() })
    expect(getPlayers).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument())
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()

    // The stale call #2 finally lands, arriving strictly after call #3's
    // already-applied, newer response.
    await act(async () => { resolveStalePoll({ players: [{ name: 'Alice' }] } as never) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently reverts the roster back to server A's ('Alice') even though
    // server B is the confirmed active one. Give the (buggy) late apply a
    // tick to land before asserting the negative.
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })
})

// continuous-bug-hunt round 26 (PanelBridge command queue and response
// matching): checkBridgeStatus runs on a 10s poll AND on activeServerChanged,
// exactly like fetchPlayers above -- but it was left ungated (see
// setUpCommon's own comment: "this race only concerns fetchPlayers"). A poll
// tick for the server that was active a moment ago, still in flight, can
// resolve AFTER the activeServerChanged-triggered call for the NEW server
// and silently revert the "Bridge connected" status badge (and everything
// gated on it) back to the OLD server's stale connectivity state. Fixed via
// the same shared useRequestGuard hook (bridgeStatusGuard in Events.tsx).
//
// Exercises the top-of-page connection badge (statusBar.online/offline)
// rather than the deeper weather/climate/utilities cascade checkBridgeStatus
// also drives once connected -- that cascade is reached through the exact
// same guarded getStatus() await, so gating that one call is sufficient to
// prove the fix; the badge is the simplest observable that doesn't require
// navigating into a specific section first.
describe('Events.tsx: an older, slower bridge-connectivity response must not overwrite a newer one', () => {
  it('keeps the newer server\'s connection status when an earlier in-flight checkBridgeStatus resolves AFTER the activeServerChanged one', async () => {
    // Defensive resets: vi.clearAllMocks() (afterEach) clears call history
    // but not a still-queued mockResolvedValue/Once implementation from a
    // prior test in this file (e.g. setUpCommon's own
    // getBridgeStatus.mockResolvedValue) -- start from a clean slate.
    getBridgeStatus.mockReset()
    getPlayers.mockResolvedValue({ players: [] } as never)
    // checkBridgeStatus fires these unconditionally once modConnected is
    // true -- an unmocked vi.fn() returns undefined, and calling .then() on
    // that throws synchronously inside checkBridgeStatus's own try block,
    // landing in its catch and forcing bridgeConnected back to false
    // regardless of what getStatus() itself resolved. Give them all a
    // trivial, non-throwing shape so this test isolates the getStatus()
    // race alone.
    getWeather.mockResolvedValue({ success: false } as never)
    getClimateFloats.mockResolvedValue({ success: false } as never)
    getGameTime.mockResolvedValue({ success: false } as never)
    getUtilitiesStatus.mockResolvedValue({ success: false } as never)

    // Call #1 (mount): resolves fast, server A is connected.
    getBridgeStatus.mockResolvedValueOnce({ modConnected: true } as never)
    renderEvents()
    // The bridge badge's own "online" collides with the page's unrelated
    // player-count status text (statusBar.onlineCount is the identical
    // literal string) -- assert the count, not mere presence.
    await waitFor(() => expect(screen.getAllByText(enEvents.statusBar.online)).toHaveLength(2))
    expect(getBridgeStatus).toHaveBeenCalledTimes(1)

    // Call #2 (a later poll tick): held open -- stands in for a slow/
    // delayed response for whichever server was active when it was issued.
    let resolveStalePoll: (value: Awaited<ReturnType<typeof panelBridgeApi.getStatus>>) => void = () => {}
    const stalePoll = new Promise<Awaited<ReturnType<typeof panelBridgeApi.getStatus>>>((resolve) => { resolveStalePoll = resolve })
    getBridgeStatus.mockImplementationOnce(() => stalePoll)
    await act(async () => { emitActiveServerChanged() })
    expect(getBridgeStatus).toHaveBeenCalledTimes(2)

    // Call #3 (a second activeServerChanged, e.g. the operator switching
    // again before call #2 ever answered): resolves immediately, server B
    // is connected too -- kept "online" throughout so the ONLY thing this
    // test isolates is whether the stale call #2 can revert it, not a
    // true/false transition that a coincidental extra render could fake.
    getBridgeStatus.mockImplementationOnce(() => Promise.resolve({ modConnected: true } as never))
    await act(async () => { emitActiveServerChanged() })
    expect(getBridgeStatus).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(screen.getAllByText(enEvents.statusBar.online)).toHaveLength(2))

    // The stale call #2 finally lands, arriving strictly after call #3's
    // already-applied, newer response -- reporting server A as DISCONNECTED
    // (e.g. its bridge dropped while the operator had already moved on).
    await act(async () => { resolveStalePoll({ modConnected: false } as never) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently flips the badge to "offline" even though server B (still
    // confirmed connected) is the active one. Give the (buggy) late apply a
    // tick to land before asserting the negative.
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByText(enEvents.statusBar.online)).toHaveLength(2)
    expect(screen.queryByText(enEvents.statusBar.offline)).not.toBeInTheDocument()
  })
})
