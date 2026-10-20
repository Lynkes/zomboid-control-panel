import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Leaderboard, { type LeaderboardPlayer } from '../Leaderboard'
import { panelBridgeApi } from '@/lib/api'

// UX restructure (slice C): a row opens the player in Players, the columns
// sort, the metric is one radio group, and a load error caused by an
// offline bridge sends the operator to the bridge settings.

type LeaderboardAnswer = Awaited<ReturnType<typeof panelBridgeApi.getLeaderboard>>

const ROWS: LeaderboardPlayer[] = [
  {
    id: 'steam:76561198000000001', username: 'Alice', displayName: 'Alice', online: true,
    currentKills: 40, allTimeKills: 1280, currentDays: 3, bestDays: 61.7, deaths: 2,
    favoriteWeapon: 'Axe', favoriteWeaponKills: 30,
  },
  {
    id: 'steam:76561198000000002', username: 'bob smith', displayName: 'Bob', online: false,
    currentKills: 10, allTimeKills: 300, currentDays: 1, bestDays: 4, deaths: 9,
    favoriteWeapon: null, favoriteWeaponKills: 0,
  },
  {
    id: 'steam:76561198000000003', username: 'Cara', displayName: 'Cara', online: true,
    currentKills: 90, allTimeKills: 900, currentDays: 8, bestDays: 8, deaths: 0,
    favoriteWeapon: 'Bat', favoriteWeaponKills: 50,
  },
]

const ANSWER: LeaderboardAnswer = {
  success: true,
  data: { players: ROWS, generatedAt: 1759900005000, trackingStartedAt: 1759000000000 },
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Leaderboard />
    </MemoryRouter>,
  )
}

function bodyNames(table: HTMLElement) {
  return [...table.querySelectorAll('tbody tr')].map((row) => row.querySelector('a')?.textContent)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Leaderboard rows', () => {
  it('link each survivor to the Players page by username', async () => {
    vi.spyOn(panelBridgeApi, 'getLeaderboard').mockResolvedValue(ANSWER)
    vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
    renderPage()
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/players?player=Alice')
    expect(within(table).getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/players?player=bob%20smith')
  })
})

describe('Leaderboard column sorting', () => {
  it('sorts by a column, says so with aria-sort, and keeps the rank numbers', async () => {
    vi.spyOn(panelBridgeApi, 'getLeaderboard').mockResolvedValue(ANSWER)
    vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
    renderPage()
    const table = await screen.findByRole('table')
    // Ranked by all-time kills by default.
    expect(bodyNames(table)).toEqual(['Alice', 'Cara', 'Bob'])
    const rankHeader = within(table).getByRole('columnheader', { name: /rank/i })
    expect(rankHeader).toHaveAttribute('aria-sort', 'ascending')

    fireEvent.click(within(table).getByRole('button', { name: /deaths/i }))
    const deathsHeader = within(table).getByRole('columnheader', { name: /deaths/i })
    expect(deathsHeader).toHaveAttribute('aria-sort', 'descending')
    expect(rankHeader).toHaveAttribute('aria-sort', 'none')
    expect(bodyNames(table)).toEqual(['Bob', 'Alice', 'Cara'])
    // The # column still shows each survivor's rank by the metric.
    expect(table.querySelector('tbody tr td')).toHaveTextContent('3')

    fireEvent.click(within(table).getByRole('button', { name: /deaths/i }))
    expect(deathsHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(bodyNames(table)).toEqual(['Cara', 'Alice', 'Bob'])

    fireEvent.click(within(table).getByRole('button', { name: /survivor/i }))
    expect(bodyNames(table)).toEqual(['Alice', 'Bob', 'Cara'])
  })

  it('keeps rows without a favourite weapon last in both directions', async () => {
    vi.spyOn(panelBridgeApi, 'getLeaderboard').mockResolvedValue(ANSWER)
    vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
    renderPage()
    const table = await screen.findByRole('table')
    const weaponButton = within(table).getByRole('button', { name: /favorite weapon/i })
    fireEvent.click(weaponButton)
    expect(bodyNames(table)).toEqual(['Alice', 'Cara', 'Bob'])
    fireEvent.click(weaponButton)
    expect(bodyNames(table)).toEqual(['Cara', 'Alice', 'Bob'])
  })
})

describe('Leaderboard metric', () => {
  it('is one radio group that re-ranks the board', async () => {
    vi.spyOn(panelBridgeApi, 'getLeaderboard').mockResolvedValue(ANSWER)
    vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
    renderPage()
    const table = await screen.findByRole('table')
    const group = screen.getByRole('radiogroup', { name: 'Leaderboard metric' })
    expect(within(group).getByRole('radio', { name: 'All-time kills' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(within(group).getByRole('radio', { name: 'Current kills' }))
    expect(within(group).getByRole('radio', { name: 'Current kills' })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(bodyNames(table)).toEqual(['Cara', 'Alice', 'Bob']))
  })
})

describe('Leaderboard load error', () => {
  it('links to the PanelBridge settings when the bridge is not running', async () => {
    vi.spyOn(panelBridgeApi, 'getLeaderboard').mockRejectedValue(new Error('Bridge not running. Start it first.'))
    vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: false, modConnected: false } as never)
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Leaderboard unavailable')).toBeInTheDocument()
    expect(within(alert).getByRole('link', { name: 'PanelBridge settings' })).toHaveAttribute('href', '/settings?tab=bridge')
  })

  it('offers Retry when the bridge is connected', async () => {
    vi.spyOn(panelBridgeApi, 'getLeaderboard').mockRejectedValue(new Error('boom'))
    vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
