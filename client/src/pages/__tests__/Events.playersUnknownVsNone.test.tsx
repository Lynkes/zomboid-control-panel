import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'
import enEvents from '../../locales/en/events.json'

// bug-hunt-2026-09-18 (round 6, following on from Console.tsx's command
// history finding in round 5): fetchPlayers()'s catch is a deliberate silent
// ignore -- the ~10-15s poll retries on its own, no need to toast every miss
// -- but `players` stayed at its initial useState([]) on failure, and
// `players.length === 0` alone drove ~15 call sites' "No players online" /
// "no players online" copy across the statusBar target picker, quick
// sounds, horde, vehicle spawn and teleport panels. A bridge hiccup on the
// very first load (or the page rendering before that first fetch resolves
// at all) told the operator confidently that nobody was online, when the
// real answer was "don't know yet." Fixed by tracking `playersLoaded` (only
// ever flips true on a successful response) and deriving `playersUnknown =
// !playersLoaded`, checked before `players.length === 0` at every one of
// those call sites, all pointed at new shared `common.playersUnavailable`/
// `common.playersUnavailableTitle` keys instead of the existing per-section
// "no players online" ones.
//
// Exercises two always-cheap-to-reach surfaces rather than a Radix Select's
// dropdown content (only mounted while open, and real pointer interaction on
// one throws in jsdom -- see Events.safehouseAddPlayerPicker.test.tsx's own
// workaround) or a DisabledReason Tooltip's content (hover/focus-only,
// fragile in jsdom): the statusBar online-count badge, always on screen
// regardless of section, and the "Spawn vehicle" panel's plain (non-Select)
// player list, reached the same way Events.safehouseAddPlayerPicker.test.tsx
// reaches its own section -- clicking the sidebar nav button by name.

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
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      sendCommand: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)

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

function openSpawnVehicleSection() {
  fireEvent.click(screen.getByRole('button', { name: enEvents.sections.vehicles.label }))
}

beforeEach(() => {
  getPlayers.mockReset()
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  getUtilitiesStatus.mockReset().mockResolvedValue({ success: false } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
})

describe('Events.tsx: player list unknown (failed/never loaded) vs confirmed none', () => {
  it('does not claim "no players online" when the fetch rejects -- shows an unavailable state instead', async () => {
    getPlayers.mockRejectedValue(new Error('bridge unreachable'))

    renderEvents()
    openSpawnVehicleSection()

    await screen.findAllByText(enEvents.common.playersUnavailable)
    expect(screen.queryByText(enEvents.vehicles.noPlayersOnline)).not.toBeInTheDocument()
    // The statusBar online-count badge must not read "0" either -- that's
    // just as confident a claim as the text, in numeral form.
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('does not claim "no players online" while the initial fetch is still in flight', async () => {
    getPlayers.mockReturnValue(new Promise(() => {}))

    renderEvents()
    openSpawnVehicleSection()

    // Give the mount effects a tick to run before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText(enEvents.vehicles.noPlayersOnline)).not.toBeInTheDocument()
    expect(screen.getAllByText(enEvents.common.playersUnavailable).length).toBeGreaterThan(0)
  })

  it('shows "no players online" once a real response confirms the roster is genuinely empty', async () => {
    getPlayers.mockResolvedValue({ players: [] } as never)

    renderEvents()
    openSpawnVehicleSection()

    await screen.findByText(enEvents.vehicles.noPlayersOnline)
    expect(screen.queryByText(enEvents.common.playersUnavailable)).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('0')).toBeInTheDocument())
  })

  it('a later failed poll keeps showing the last known roster instead of reverting to unknown', async () => {
    getPlayers.mockResolvedValueOnce({ players: [{ name: 'Zed' }] } as never)

    renderEvents()
    openSpawnVehicleSection()

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    await screen.findByText('Zed')

    getPlayers.mockRejectedValueOnce(new Error('transient'))
    fireEvent.click(screen.getByRole('button', { name: enEvents.pageHeader.refreshPlayers }))

    await waitFor(() => expect(getPlayers).toHaveBeenCalledTimes(2))
    // Still showing the roster from the successful call, not reverted to
    // unknown or to a confident zero.
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('Zed')).toBeInTheDocument()
    expect(screen.queryByText(enEvents.common.playersUnavailable)).not.toBeInTheDocument()
    expect(screen.queryByText(enEvents.vehicles.noPlayersOnline)).not.toBeInTheDocument()
  })
})
