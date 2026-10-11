import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// Issue #232: a Mod Manager with hundreds of ignored mods could only be taken
// apart one "Re-track" click at a time, and the only bulk button ("Clear all
// ignored") sat below the whole list and cleared everything without asking.
// The ignored panel now has a toolbar above the list: select all / select some,
// "Remove selected", and a Clear all that asks first.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

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
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
      unignoreMod: vi.fn(),
      unignoreMods: vi.fn(),
      clearAllIgnoredMods: vi.fn(),
    },
  }
})

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
}))

const m = vi.mocked(modsApi)

const IGNORED = [
  { workshop_id: '111', name: 'Alpha Mod', ignored_at: '2026-10-01T00:00:00.000Z' },
  { workshop_id: '222', name: 'Beta Mod', ignored_at: '2026-10-01T00:00:00.000Z' },
  { workshop_id: '333', name: null, ignored_at: '2026-10-01T00:00:00.000Z' },
]

beforeEach(() => {
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 0, workshopAcfConfigured: true, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as never)
  m.getIgnoredMods.mockResolvedValue(IGNORED as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  m.unignoreMods.mockResolvedValue({ success: true, removed: 2 } as never)
  m.clearAllIgnoredMods.mockResolvedValue({ success: true, removed: 3, message: 'Cleared 3 ignored mods' } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openIgnoredPanel() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByText(/3 ignored mods/))
  await screen.findByText('Alpha Mod')
}

describe('Mods.tsx: ignored list bulk actions', () => {
  it('Remove selected sends exactly the ticked ids in one request and no per-row calls', async () => {
    await openIgnoredPanel()
    const removeSelected = screen.getByRole('button', { name: /remove selected \(0\)/i })
    expect(removeSelected).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha Mod' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta Mod' }))
    fireEvent.click(screen.getByRole('button', { name: /remove selected \(2\)/i }))

    await waitFor(() => expect(m.unignoreMods).toHaveBeenCalledTimes(1))
    expect([...(m.unignoreMods.mock.calls[0][0] as string[])].sort()).toEqual(['111', '222'])
    expect(m.unignoreMod).not.toHaveBeenCalled()
    expect(m.clearAllIgnoredMods).not.toHaveBeenCalled()
  })

  it('Select all ticks every row, and ticking it again clears the selection', async () => {
    await openIgnoredPanel()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: /remove selected \(3\)/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: /remove selected \(0\)/i })).toBeDisabled()
  })

  it('Clear all ignored asks first and does nothing when declined', async () => {
    confirmSpy.mockResolvedValue(false)
    await openIgnoredPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all ignored' }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0].description).toContain('3')
    expect(m.clearAllIgnoredMods).not.toHaveBeenCalled()
  })

  it('Clear all ignored clears the list once confirmed', async () => {
    confirmSpy.mockResolvedValue(true)
    await openIgnoredPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all ignored' }))

    await waitFor(() => expect(m.clearAllIgnoredMods).toHaveBeenCalledTimes(1))
  })

  it('the per-row button is called Un-ignore (it only takes the mod off the list)', async () => {
    await openIgnoredPanel()
    expect(screen.getAllByRole('button', { name: 'Un-ignore' })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Re-track' })).toBeNull()
  })
})
