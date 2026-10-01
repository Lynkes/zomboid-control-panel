import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import en from '../../locales/en/players.json'

// 2026-09 dialog sweep, visual verify: on a landscape phone (853x413) the
// Teleport dialog -- target, eight quick locations, X/Y/Z -- is taller than
// the window. It scrolled as a whole, so the Teleport button opened 8px
// below the fold. The fields now scroll in a DialogBody and the button stays
// in the pinned footer. jsdom does no layout: this pins the structure that
// Chromium was measured against (body scrolls 111px, Teleport on screen).

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openTeleportDialog() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({ levels: ['admin', 'user', 'none'], available: true })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [] })
  vi.mocked(playersApi.getStats).mockResolvedValue({ stats: [] })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: false, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(panelBridgeApi.getAllPlayerDetails).mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)

  render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )

  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  const tile = screen.getAllByText(en.actionTiles.teleportLabel)
    .map((el) => el.closest('button'))
    .find((btn): btn is HTMLButtonElement => btn !== null)
  if (!tile) throw new Error('Teleport tile has no <button> ancestor')
  fireEvent.click(tile)
  await screen.findByRole('heading', { name: en.teleportDialog.title })
  return screen.getByRole('dialog')
}

describe('Players.tsx: the Teleport dialog keeps its button on a short window', () => {
  it('scrolls the fields in a DialogBody; the title and Teleport stay outside it', async () => {
    const dialog = await openTeleportDialog()
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')

    const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
    expect(body).not.toBeNull()
    for (const label of [en.teleportDialog.targetLabel, en.teleportDialog.xLabel, en.teleportDialog.zLabel]) {
      expect(body!.contains(within(dialog).getByLabelText(label))).toBe(true)
    }
    expect(body!.contains(within(dialog).getByText('Muldraugh'))).toBe(true)

    const title = within(dialog).getByRole('heading', { name: en.teleportDialog.title })
    const submit = within(dialog).getByRole('button', { name: en.teleportDialog.submit })
    expect(body!.contains(title)).toBe(false)
    expect(body!.contains(submit)).toBe(false)
    expect(dialog.contains(submit)).toBe(true)
  })
})
