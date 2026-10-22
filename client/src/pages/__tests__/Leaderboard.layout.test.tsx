import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import Leaderboard from '../Leaderboard'
import { panelBridgeApi } from '@/lib/api'

// The table is read right to left in Arabic: its header cells said text-left
// and its numbers text-right while the body cells followed the reading
// direction, and the "d" after the best days was English in every language.

type LeaderboardAnswer = Awaited<ReturnType<typeof panelBridgeApi.getLeaderboard>>

const ANSWER: LeaderboardAnswer = {
  success: true,
  data: {
    players: [
      {
        id: 'steam:76561198000000001', username: 'Alice', displayName: 'Alice', online: true,
        currentKills: 40, allTimeKills: 1280, currentDays: 3, bestDays: 61.7, deaths: 2,
        favoriteWeapon: 'Axe', favoriteWeaponKills: 30,
      },
    ],
    generatedAt: 1759900005000,
    trackingStartedAt: 1759000000000,
  },
}

async function renderPage(language: string) {
  await i18n.changeLanguage(language)
  vi.spyOn(panelBridgeApi, 'getLeaderboard').mockResolvedValue(ANSWER)
  vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
  render(
    <MemoryRouter>
      <Leaderboard />
    </MemoryRouter>,
  )
  return screen.findByRole('table')
}

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('Leaderboard table alignment', () => {
  it('follows the reading direction instead of left and right', async () => {
    const table = await renderPage('ar')
    const headerRow = table.querySelector('thead tr')!
    expect(headerRow).toHaveClass('text-start')
    expect(table.querySelectorAll('.text-left, .text-right')).toHaveLength(0)
  })

  it('puts the four number columns at the end of the cell in the header and the body alike', async () => {
    const table = await renderPage('en')
    const headers = [...table.querySelectorAll('thead th')]
    const cells = [...table.querySelectorAll('tbody tr:first-child td')]
    // # | survivor | best days | current kills | all-time kills | deaths | weapon
    const numeric = [2, 3, 4, 5]
    for (const column of numeric) {
      expect(headers[column]).toHaveClass('text-end')
      expect(cells[column]).toHaveClass('text-end')
    }
    for (const column of [1, 6]) {
      expect(headers[column]).not.toHaveClass('text-end')
      expect(cells[column]).not.toHaveClass('text-end')
    }
  })
})

describe('Leaderboard days unit', () => {
  it('is the English abbreviation in English', async () => {
    const table = await renderPage('en')
    expect(table.querySelector('tbody tr td:nth-child(3)')).toHaveTextContent('61.7 d')
    // The podium and the leader tile show it too when ranked by days.
    expect(screen.queryByText('61.7 d', { selector: 'td' })).toBeInTheDocument()
  })

  it.each([
    ['de', '61,7 T'],
    ['fr', '61,7 j'],
    ['uk', '61,7 дн.'],
    ['zh-CN', '61.7 天'],
  ])('is translated in %s', async (language, expected) => {
    const table = await renderPage(language)
    const cell = table.querySelector('tbody tr td:nth-child(3)')!
    expect(cell.textContent).toBe(expected)
    expect(cell.textContent).not.toMatch(/ d$/)
  })

  it('is translated in the podium and leader tile when ranked by days', async () => {
    const table = await renderPage('de')
    expect(table).toBeInTheDocument()
    // Ranked by all-time kills by default: no days there, so pick the metric.
    fireEvent.click(screen.getByRole('radio', { name: 'Überlebte Tage' }))
    // The table cell, the podium place and the leader tile.
    await waitFor(() => expect(screen.getAllByText('61,7 T')).toHaveLength(3))
    expect(screen.queryByText('61,7 d')).not.toBeInTheDocument()
  })
})
