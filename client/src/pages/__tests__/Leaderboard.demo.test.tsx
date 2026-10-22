import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Leaderboard from '../Leaderboard'
import { getDemoLeaderboard, installDemoFetchShim } from '@/lib/demo'
import type { panelBridgeApi } from '@/lib/api'
import en from '@/locales/en/leaderboard.json'

// The public demo has no backend, and its catch-all answered the leaderboard
// request with a 404, so the page said "unavailable". The shim now answers
// with a small board that shows every part of the page, including the
// "Not read yet" badge.

describe('demo Leaderboard', () => {
  const originalFetch = window.fetch

  beforeAll(() => {
    vi.stubEnv('VITE_DEMO_MODE', 'true')
    installDemoFetchShim()
  })
  afterAll(() => {
    cleanup()
    window.fetch = originalFetch
    vi.unstubAllEnvs()
  })

  it('is the answer getLeaderboard types, with a diagnostics block', () => {
    const answer: Awaited<ReturnType<typeof panelBridgeApi.getLeaderboard>> = getDemoLeaderboard()
    expect(answer.success).toBe(true)
    expect(answer.data.players.length).toBeGreaterThanOrEqual(5)
    expect(answer.data.diagnostics).toMatchObject({ bridgeVersion: expect.any(String), resets: [] })
    // The same id format the bridge writes, and every id different.
    const ids = answer.data.players.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^steam:\d{17}$/.test(id))).toBe(true)
  })

  it('keeps its times relative to now, so nothing reads as months old', () => {
    const now = Date.UTC(2031, 0, 15, 12, 0, 0)
    const { data } = getDemoLeaderboard(now)
    expect(data.generatedAt).toBe(now)
    expect(data.trackingStartedAt).toBeLessThan(now)
    for (const row of data.players) {
      expect(row.lastSeenAt).toBeLessThanOrEqual(now)
      if (row.lastSampledAt !== undefined) expect(row.lastSampledAt).toBeLessThanOrEqual(now)
    }
  })

  it('renders the board instead of "unavailable", with one row marked Not read yet', async () => {
    render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    )
    const table = await screen.findByRole('table')
    expect(screen.queryByText(en.errors.title)).not.toBeInTheDocument()
    expect(within(table).getByText('Marlow K')).toBeInTheDocument()
    expect(within(table).getAllByText(en.table.notReadYet)).toHaveLength(1)
    expect(screen.getByText(/1\.7\.74/)).toBeInTheDocument()
  })
})
