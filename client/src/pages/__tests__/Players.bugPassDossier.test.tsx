import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'

// Redesign bug pass (never shipped):
// - The note box and tags stayed editable for a role without
//   players.moderate, and the new unsaved-changes guard then asked that role
//   to keep edits it could never save.
// - The Kick/Ban/Teleport dialogs moved to the page root and stayed open,
//   with no player, after an active-server switch.
// - "bob" typed for an online "Bob" read Offline (exact-case match).

const caps = vi.hoisted(() => ({ denied: new Set<string>() }))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'custom', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => !caps.denied.has(capability),
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
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), getAllPlayerDetails: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
  }
})

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))

function setUp() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'Bob', online: true }] })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [] })
  vi.mocked(playersApi.getStats).mockResolvedValue({ stats: [] })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: true, isRunning: true } as never)
  vi.mocked(panelBridgeApi.getAllPlayerDetails).mockResolvedValue({ success: false } as never)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as never)
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <Players />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
  caps.denied = new Set()
})

describe('Players.tsx dossier', () => {
  it('keeps the note and tags read-only for a role that cannot save them', async () => {
    caps.denied = new Set(['players.moderate'])
    setUp()
    renderAt('/players?player=Bob&tab=notes')

    const note = await screen.findByRole('textbox', { name: 'Admin Note' }, { timeout: 3000 })
    expect(note).toHaveAttribute('readonly')
    expect(screen.getByPlaceholderText('Add tag...')).toBeDisabled()
  })

  it('shows a player typed in another letter case as online', async () => {
    setUp()
    renderAt('/players')

    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.change(screen.getByLabelText('Manual target'), { target: { value: 'bob' } })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'bob' })).toBeInTheDocument(), { timeout: 3000 })
    await waitFor(() => expect(screen.getAllByText('Online').length).toBeGreaterThan(0))
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('closes an open Kick dialog when the active server changes', async () => {
    setUp()
    renderAt('/players?player=Bob')

    fireEvent.click(await screen.findByTitle('Kick player', {}, { timeout: 3000 }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await act(async () => {
      socketHandlers.get('activeServerChanged')?.forEach((h) => h())
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
