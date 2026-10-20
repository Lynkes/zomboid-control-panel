import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// The server matches a note's player case-insensitively and REPLACES the note
// on save (server/database/init.js upsertPlayerNote). The page keyed notes by
// the exact name, so "bob" opened an empty Notes box even though "Bob" had a
// note, and saving it wiped Bob's note with whatever was typed.

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

const storedNote = {
  id: 'n1',
  player_name: 'Bob',
  note: 'Owes the trader 200 nails',
  tags: ['debtor'],
  created_at: '2026-10-01T10:00:00.000Z',
  updated_at: '2026-10-02T11:30:00.000Z',
}

function setUp() {
  // The game reports this player as "bob"; the note was written for "Bob".
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'bob', online: true }] })
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

describe('Players.tsx: a note belongs to its player whatever the letter case', () => {
  it('shows the note stored for "Bob" on the roster row and Notes tab of "bob"', async () => {
    setUp()
    renderPlayers()

    await waitFor(() => expect(screen.getByText('debtor')).toBeInTheDocument(), { timeout: 3000 })

    fireEvent.click(screen.getByText('bob'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'bob' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Notes/ }), { button: 0 })

    const box = await screen.findByDisplayValue('Owes the trader 200 nails')
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()

    // Saving edits the stored note instead of replacing it from a blank box.
    fireEvent.change(box, { target: { value: 'Owes the trader 200 nails. Paid 50.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Note' }))
    await waitFor(() => expect(saveNote).toHaveBeenCalledWith('bob', 'Owes the trader 200 nails. Paid 50.', ['debtor']))
  })
})
