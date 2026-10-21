import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// 2026-08-31 visual sweep, three findings in one shared file:
//
// #3 Moderation action-card descriptions used a single-line `truncate`,
//    which read fine on mobile's wide single column but cut real meaning out
//    on desktop's narrower grid ("Permanent · two-step" -> "Permanent ·
//    two-s..."). Swapped for line-clamp-2.
// #4 The player's Character/Moderation/Spawn/Powers/Notes tab strip
//    (Vitals until v1.4.1, when the Character tab replaced it)
//    used horizontal scroll with only a 12px edge mask as the cue -- easy to
//    miss, and it starts scrolled to the clipped position by default
//    ("Notes & Log" read as a bare "N"). Switched to flex-wrap, matching
//    Debug.tsx's own already-working tab strip for the same label-only shape.
// #7 The Activity Log table's Details column was `hidden sm:table-cell`,
//    dropping it below 640px with no way to reach it. The log is now the
//    roster card's Activity list, which shows the details on every row.

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
// stub keeps these layout tests off the network.
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPlayers(initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({
    logs: [{ id: 1, player_name: 'TestPlayer', action: 'kick', details: 'Reason: griefing base', logged_at: '2026-08-31T00:00:00.000Z' }],
  })
  getStatus.mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayer() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
}

describe('Players.tsx dossier: mobile-affordance fixes', () => {
  it('opens the requested player when linked from the World Map dossier', async () => {
    await setUpFixtures()
    renderPlayers(['/players?player=TestPlayer'])

    await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
    expect(screen.getByRole('tab', { name: 'Character' })).toBeInTheDocument()
  })

  it('#4 tab strip wraps instead of clipping into a horizontal scroller', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()

    // The player's own tab list (the roster lists are a separate tablist).
    const tabList = screen.getByRole('tablist', { name: 'Tools for TestPlayer' })
    const tabs = ['Character', 'Moderation', 'Spawn', 'Powers', 'Notes'].map(
      (name) => within(tabList).getByRole('tab', { name }),
    )
    // In this order.
    expect(within(tabList).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Character',
      'Moderation',
      'Spawn',
      'Powers',
      'Notes',
    ])
    // All five simultaneously present and un-nested from any scroll
    // container -- the old markup wrapped TabsList in an overflow-x-auto
    // div; the fix removes that wrapper entirely.
    for (const tab of tabs) {
      expect(tab).toBeInTheDocument()
      expect(tab.closest('[class*="overflow-x-auto"]')).toBeNull()
    }
    expect(tabList.className).toContain('flex-wrap')
  })

  it('#3 Moderation action-tile descriptions clamp to 2 lines instead of truncating to 1', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Moderation' }), { button: 0 })

    for (const text of ['Admin · Mod · User', 'Create their account on a whitelist-only server']) {
      const desc = await screen.findByText(text)
      expect(desc.className).toContain('line-clamp-2')
      expect(desc.className).not.toMatch(/\btruncate\b/)
    }
  })

  it('#3b Spawn tab Give Items / Spawn Vehicles descriptions clamp to 2 lines instead of truncating to 1', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Spawn' }), { button: 0 })

    const giveItemsDesc = (await screen.findByText('Give items')).closest('div.flex-1')!.querySelector('p:last-child')!
    expect(giveItemsDesc.className).toContain('line-clamp-2')
    expect(giveItemsDesc.className).not.toMatch(/\btruncate\b/)

    const spawnVehiclesDesc = screen.getByText('Spawn vehicles').closest('div.flex-1')!.querySelector('p:last-child')!
    expect(spawnVehiclesDesc.className).toContain('line-clamp-2')
    expect(spawnVehiclesDesc.className).not.toMatch(/\btruncate\b/)
  })

  it('#7 Activity entries show their details at every width', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayer()
    // The log is the roster card's Activity list now: a list, not a table,
    // so there is no column to hide below sm.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Activity' }), { button: 0 })

    const matches = await screen.findAllByText('Reason: griefing base')
    expect(matches).toHaveLength(1)
    expect(matches[0].className).not.toMatch(/\bhidden\b/)
  })
})
