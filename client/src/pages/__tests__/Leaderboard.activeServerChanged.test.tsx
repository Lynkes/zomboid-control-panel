import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Leaderboard from '../Leaderboard'
import { panelBridgeApi } from '@/lib/api'
import { SocketContext } from '@/contexts/SocketContext'

// The board belongs to one server, but the page never listened for
// activeServerChanged: after a switch the old server's board stayed on screen
// until the next 30 s poll, and a slow request sent for the old server could
// resolve after the new server's and overwrite it.

type LeaderboardAnswer = Awaited<ReturnType<typeof panelBridgeApi.getLeaderboard>>

function row(username: string) {
  return {
    id: `steam:${username}`, username, displayName: username, online: true,
    currentKills: 1, allTimeKills: 1, currentDays: 1, bestDays: 1, deaths: 0,
    favoriteWeapon: 'Axe', favoriteWeaponKills: 1,
  }
}

function board(username: string): LeaderboardAnswer {
  return {
    success: true,
    data: { players: [row(username)], generatedAt: 1759900005000, trackingStartedAt: 1759000000000 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const socketHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
const fakeSocket = {
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

function emitActiveServerChanged() {
  act(() => {
    socketHandlers.get('activeServerChanged')?.forEach((h) => h())
  })
}

function renderPage() {
  vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue({ isRunning: true, modConnected: true } as never)
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={fakeSocket}>
        <Leaderboard />
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  socketHandlers.clear()
})

// Failing fast when the new board never shows up beats the 45 s default.
const SHORT = { timeout: 4000 }

describe('Leaderboard.tsx: follows the active server', () => {
  it('drops the old server\'s board at once and shows the new one when it arrives', async () => {
    const newBoard = deferred<LeaderboardAnswer>()
    const getLeaderboard = vi.spyOn(panelBridgeApi, 'getLeaderboard')
    getLeaderboard.mockResolvedValueOnce(board('OldServerPlayer'))
    getLeaderboard.mockReturnValueOnce(newBoard.promise)

    renderPage()
    await waitFor(() => expect(screen.getAllByText('OldServerPlayer').length).toBeGreaterThan(0), SHORT)

    emitActiveServerChanged()

    // The new server's request is still in flight: nothing of the old board
    // may stay up in the meantime.
    await waitFor(() => expect(screen.queryByText('OldServerPlayer')).not.toBeInTheDocument(), SHORT)

    await act(async () => { newBoard.resolve(board('NewServerPlayer')) })
    await waitFor(() => expect(screen.getAllByText('NewServerPlayer').length).toBeGreaterThan(0), SHORT)
    expect(screen.queryByText('OldServerPlayer')).not.toBeInTheDocument()
  })

  it('ignores a slow answer for the old server that lands after the new server\'s', async () => {
    const slowOld = deferred<LeaderboardAnswer>()
    const getLeaderboard = vi.spyOn(panelBridgeApi, 'getLeaderboard')
    getLeaderboard.mockResolvedValueOnce(board('FirstLoad'))
    getLeaderboard.mockReturnValueOnce(slowOld.promise)
    getLeaderboard.mockResolvedValue(board('NewServerPlayer'))

    renderPage()
    await waitFor(() => expect(screen.getAllByText('FirstLoad').length).toBeGreaterThan(0), SHORT)

    // A refresh for the old server is in flight when the operator switches.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(getLeaderboard).toHaveBeenCalledTimes(2), SHORT)

    emitActiveServerChanged()
    await waitFor(() => expect(screen.getAllByText('NewServerPlayer').length).toBeGreaterThan(0), SHORT)

    await act(async () => { slowOld.resolve(board('OldServerPlayer')) })

    expect(screen.queryByText('OldServerPlayer')).not.toBeInTheDocument()
    expect(screen.getAllByText('NewServerPlayer').length).toBeGreaterThan(0)
  })
})
