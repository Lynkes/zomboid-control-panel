import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// GET /players/notes returns the stored rows (server/database/init.js
// upsertPlayerNote), which name the player in snake_case `player_name`. The
// page indexed them by `playerName`, so every note landed under "undefined":
// after any reload the roster showed no tag and the Notes tab was empty, and
// saving again replaced the stored note with whatever was typed from scratch.

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
      saveNote: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getAllPlayerDetails: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
  }
})

const saveNote = vi.mocked(playersApi.saveNote)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The row exactly as upsertPlayerNote stores it and GET /players/notes sends it.
const storedNote = {
  id: 'a1b2c3',
  player_name: 'Alice',
  note: 'Watch for griefing near the gas station',
  tags: ['griefer', 'vip'],
  created_at: '2026-10-01T10:00:00.000Z',
  updated_at: '2026-10-02T11:30:00.000Z',
}

function setUp() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'Alice', online: true }, { name: 'Bob', online: true }] })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [storedNote] })
  vi.mocked(playersApi.getStats).mockResolvedValue({ stats: [] })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  saveNote.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof playersApi.saveNote>>)
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: false, isRunning: false } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(panelBridgeApi.getAllPlayerDetails).mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
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

describe('Players.tsx: stored notes (snake_case player_name) show up for their player', () => {
  it('shows the tags on the roster row after a reload', async () => {
    setUp()
    renderPlayers()

    await waitFor(() => expect(screen.getByText('griefer')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText('vip')).toBeInTheDocument()
  })

  it('opens the Notes tab with the stored note and tags, and a Delete button, for that player only', async () => {
    setUp()
    renderPlayers()
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument(), { timeout: 3000 })

    fireEvent.click(screen.getByText('Alice'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Notes/ }), { button: 0 })

    expect(await screen.findByDisplayValue('Watch for griefing near the gas station')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove griefer tag' })).toBeInTheDocument()

    // Another player has no note.
    fireEvent.click(screen.getByText('Bob'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bob' })).toBeInTheDocument(), { timeout: 3000 })
    await waitFor(() => expect(screen.queryByDisplayValue('Watch for griefing near the gas station')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('editing the stored note saves the edit on top of what was stored, not from a blank box', async () => {
    setUp()
    renderPlayers()
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByText('Alice'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Notes/ }), { button: 0 })

    const box = await screen.findByDisplayValue('Watch for griefing near the gas station')
    fireEvent.change(box, { target: { value: 'Watch for griefing near the gas station. Warned twice.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Note' }))

    await waitFor(() => expect(saveNote).toHaveBeenCalledWith(
      'Alice',
      'Watch for griefing near the gas station. Warned twice.',
      ['griefer', 'vip'],
    ))
  })
})
