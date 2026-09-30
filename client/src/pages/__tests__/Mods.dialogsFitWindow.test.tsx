import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi } from '@/lib/api'

// 2026-09 dialog sweep (after the Templates preview community report), each
// measured in Chromium at 375x667 / 853x413 / 1280x620 / 1920x1080:
//  - Add Mod: after Discover (with Review IDs open, a 50vh list scrolling
//    inside a dialog that scrolled as a whole under its own 85vh cap) the
//    Add button was below the fold at 1280x620;
//  - Import Collection: same own cap plus a fixed-height list, so "Add N
//    Mods to Server" started below the fold on a laptop and the wheel over
//    the list never reached it;
//  - Auto-Restart Settings: Save below the fold on a landscape phone.
// Each now scrolls only a DialogBody under DialogContent's own bound, with
// one scroller inside it. jsdom does no layout; this pins the structure.

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
      discoverModIds: vi.fn(),
      importCollection: vi.fn(),
    },
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

const m = vi.mocked(modsApi)

function primeReadMocks() {
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  // totalModsTracked > 0 so the "More actions" menu renders.
  m.getStatus.mockResolvedValue({
    totalModsTracked: 1, workshopAcfConfigured: false, autoRestartEnabled: true,
    restartWarningMinutes: 5, delayIfPlayersOnline: true, maxDelayMinutes: 30,
  } as never)
  m.getCurrentConfig.mockResolvedValue({ configured: true, modIds: [], workshopIds: [], maps: [], totalMods: 0 } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

async function renderMods() {
  primeReadMocks()
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
}

function expectPinnedLayout(dialog: HTMLElement, buttons: RegExp[]) {
  expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
  expect(dialog.className).not.toContain('max-h-[85vh]')
  const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
  expect(body).not.toBeNull()
  for (const name of buttons) {
    expect(body!.contains(within(dialog).getByRole('button', { name }))).toBe(false)
  }
  return body!
}

describe('Mods dialogs fit a short window', () => {
  it('Add Mod: the discovered mod and its ID list scroll in one body; Add and Cancel stay put', async () => {
    m.discoverModIds.mockResolvedValue({
      workshopId: '2999999999',
      name: "Filibuster Rhymes' Used Cars! (Build 42) - Expanded Community Edition",
      description: null,
      modIds: Array.from({ length: 24 }, (_, i) => `SAKUPrecisionSVE_Vehicles_Expanded_CommunityEdition_${i}`),
      hasMultipleModIds: true,
      isMap: true,
      mapFolders: ['RavenCreek_Expanded_Community_Edition_Map_Folder'],
      isDownloaded: true,
      tags: [],
    } as never)
    await renderMods()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText(/paste workshop url or enter id/i), { target: { value: '2999999999' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^discover$/i }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Review IDs' }))

    const body = expectPinnedLayout(dialog, [/^add /i, /^cancel$/i])
    const firstId = within(body).getByText('SAKUPrecisionSVE_Vehicles_Expanded_CommunityEdition_0')
    const list = firstId.closest('[role="button"]')!.parentElement!
    // One scroller: the ID list flows in the body instead of its own 50vh box.
    expect(list.className).not.toMatch(/max-h-|overflow-y-auto/)
    // The unspaced map folder name wraps.
    expect(within(body).getByText('RavenCreek_Expanded_Community_Edition_Map_Folder').className).toContain('[overflow-wrap:anywhere]')
  })

  it('Import Collection: the mod list is the one scroller, shrinking inside a flex-column body', async () => {
    m.importCollection.mockResolvedValue({
      mods: Array.from({ length: 12 }, (_, i) => ({ workshopId: String(3000000000 + i), name: `Authentic Z - Current [B42] | Clothing, Hats, Masks, Backpacks & More ${i}`, isMap: false })),
    } as never)
    await renderMods()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /import an entire collection/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Collection URL or ID'), { target: { value: '987654321' } })
    fireEvent.click(within(dialog).getAllByRole('button').find((b) => b.querySelector('svg.lucide-download'))!)
    const name = await within(dialog).findByText('Authentic Z - Current [B42] | Clothing, Hats, Masks, Backpacks & More 0')

    const body = expectPinnedLayout(dialog, [/add .*mods? to server/i, /^cancel$/i])
    expect(body.className).toContain('flex-col')
    expect(name).toHaveAttribute('title', name.textContent)
    const list = name.closest('.overflow-y-auto') as HTMLElement
    expect(body.contains(list)).toBe(true)
    expect(list).not.toBe(body)
    expect(list.className).toContain('min-h-24')
    expect(list.className).toContain('max-h-[min(48vh,22rem)]')
    const section = list.parentElement!
    expect(section.className).toContain('min-h-0')
    expect(section.className).toContain('flex-col')
  })

  it('Auto-Restart Settings: the fields scroll in a body; Save and Cancel stay put', async () => {
    await renderMods()
    const trigger = await screen.findByRole('button', { name: /more actions/i })
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
    fireEvent.click(trigger)
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /auto-restart settings/i }))
    const dialog = await screen.findByRole('dialog')
    const body = expectPinnedLayout(dialog, [/save settings/i, /^cancel$/i])
    expect(body.contains(within(dialog).getByLabelText(/warning time/i))).toBe(true)
  })
})
