import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Leaderboard from '../Leaderboard'
import { panelBridgeApi } from '@/lib/api'
import { copyText } from '@/lib/utils'

// ejspinn (Discord, 2026-10): "it keeps track of other players but not me".
// PanelBridge up to 1.7.73 only read kills and days while someone had this
// page open, so a player who played unwatched kept 0 kills or had no row.
// Newer bridges read everyone once a minute and say when each row was last
// read; the page marks rows never read, and "Copy diagnostics" gives the
// admin something to paste in a support thread without any SteamID.

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, copyText: vi.fn(async () => true) }
})

type LeaderboardAnswer = Awaited<ReturnType<typeof panelBridgeApi.getLeaderboard>>

const ROWS = [
  {
    id: 'steam:76561198000000001', username: 'Alice', displayName: 'Alice', online: true,
    currentKills: 40, allTimeKills: 80, currentDays: 3, bestDays: 5, deaths: 1,
    favoriteWeapon: 'Axe', favoriteWeaponKills: 30, lastSeenAt: 1759900000000,
    lastSampledAt: 1759900000000, lastSampleSource: 'sweep', aliases: ['alicealt'], awaitingNewLife: false,
  },
  {
    id: 'steam:76561198000000002', username: 'ejspinn', displayName: 'ejspinn', online: false,
    currentKills: 0, allTimeKills: 0, currentDays: 0, bestDays: 0, deaths: 2,
    favoriteWeapon: 'Bat', favoriteWeaponKills: 4, lastSeenAt: 1759800000000,
  },
]

function answer(withDiagnostics: boolean): LeaderboardAnswer {
  return {
    success: true,
    data: {
      players: ROWS,
      generatedAt: 1759900005000,
      trackingStartedAt: 1759000000000,
      ...(withDiagnostics
        ? {
            diagnostics: {
              bridgeVersion: '1.7.74',
              sweepIntervalMs: 60000,
              lastSweepAt: 1759900000000,
              sweepCount: 42,
              lastSweepPlayers: 1,
              loadedFrom: 'leaderboard.2.json',
              flushSeq: 17,
              resets: [{ at: 1759100000000, reason: 'world changed' }],
            },
          }
        : {}),
    },
  }
}

function renderPage(withDiagnostics: boolean) {
  vi.spyOn(panelBridgeApi, 'getLeaderboard').mockResolvedValue(answer(withDiagnostics))
  vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
  return render(
    <MemoryRouter>
      <Leaderboard />
    </MemoryRouter>,
  )
}

function rowOf(username: string): HTMLElement {
  const cell = screen.getAllByText(username).find((el) => el.closest('tr'))
  const row = cell?.closest('tr')
  if (!row) throw new Error(`no table row for ${username}`)
  return row as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(copyText).mockClear()
})

describe('Leaderboard > rows the bridge has not read', () => {
  it('marks a row never read, and gives a read row its last read time', async () => {
    renderPage(true)
    await screen.findByText('All survivors')

    expect(within(rowOf('ejspinn')).getByText('Not read yet')).toBeInTheDocument()
    expect(within(rowOf('Alice')).queryByText('Not read yet')).toBeNull()
    expect(within(rowOf('Alice')).getByText('Alice', { selector: 'span' }).getAttribute('title')).toMatch(/^Last read /)

    expect(screen.getByText('PanelBridge 1.7.74')).toBeInTheDocument()
    expect(screen.getByText(/^Last sweep /)).toBeInTheDocument()
    expect(screen.getByText('Resets: 1')).toBeInTheDocument()
  })

  it('shows no badge for a bridge that does not report reads, and says to update it', async () => {
    renderPage(false)
    await screen.findByText('All survivors')

    expect(screen.queryByText('Not read yet')).toBeNull()
    expect(screen.getByText(/reads kills only when asked/)).toBeInTheDocument()
    expect(screen.queryByText(/^Resets:/)).toBeNull()
  })
})

describe('Leaderboard > Copy diagnostics', () => {
  it('copies usernames and read times, never a row id or an alias', async () => {
    renderPage(true)
    await screen.findByText('All survivors')

    fireEvent.click(screen.getByRole('button', { name: /copy diagnostics/i }))
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument()

    const text = vi.mocked(copyText).mock.calls[0][0]
    expect(text).not.toMatch(/steam:|7656119/)
    expect(text).not.toMatch(/alicealt/)
    const copied = JSON.parse(text)
    expect(copied.bridge).toEqual(expect.objectContaining({ version: '1.7.74', sweepCount: 42 }))
    expect(copied.notReadCount).toBe(1)
    expect(copied.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: 'Alice', read: true, aliasCount: 1, lastSampleSource: 'sweep', allTimeKills: 80 }),
      expect.objectContaining({ username: 'ejspinn', read: false, lastSampledAt: null, deaths: 2 }),
    ]))
  })
})
