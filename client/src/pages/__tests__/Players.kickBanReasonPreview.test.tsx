import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import en from '../../locales/en/players.json'

// bug-hunt-2026-09-18 (round 16, silently-altered player-action text sweep):
// kickPlayer()/banPlayer() (server/services/rcon.js) both fold curly quotes/
// accents to plain ASCII, strip anything outside a narrow whitelist, and
// truncate to 100 chars -- silently, with no error. banPlayer() already
// computed and returned the real sentReason for exactly this reason, but
// nothing in the client ever surfaced it; the operator only found out (if
// ever) by asking the banned player what reason they actually saw. This
// proves the Kick dialog now warns BEFORE submit, using the same
// server-side rule (mirrored in lib/rconTextPreview.ts), whenever what will
// actually be sent differs from what was typed.

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
      kick: vi.fn(),
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

const getPlayers = vi.mocked(playersApi.getPlayers)
const getWhitelist = vi.mocked(playersApi.getWhitelist)
const getPerks = vi.mocked(playersApi.getPerks)
const getAccessLevels = vi.mocked(playersApi.getAccessLevels)
const getSteamIdBans = vi.mocked(playersApi.getSteamIdBans)
const getNotes = vi.mocked(playersApi.getNotes)
const getStats = vi.mocked(playersApi.getStats)
const getExports = vi.mocked(playersApi.getExports)
const getActivityLogs = vi.mocked(playersApi.getActivityLogs)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getAllPlayerDetails = vi.mocked(panelBridgeApi.getAllPlayerDetails)
const getAppSettings = vi.mocked(configApi.getAppSettings)

function renderPlayers() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Players />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getPlayers.mockResolvedValue({ players: [{ name: 'TestPlayer', online: true }] })
  getWhitelist.mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  getPerks.mockResolvedValue({ catalog: [] })
  getAccessLevels.mockResolvedValue({ levels: ['admin', 'moderator', 'gm', 'observer', 'priority', 'user', 'none'], available: true })
  getSteamIdBans.mockResolvedValue({ bans: [] })
  getNotes.mockResolvedValue({ notes: [] })
  getStats.mockResolvedValue({ stats: [] })
  getExports.mockResolvedValue({ exports: [] })
  getActivityLogs.mockResolvedValue({ logs: [] })
  getStatus.mockResolvedValue({ modConnected: false, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getAllPlayerDetails.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getAllPlayerDetails>>)
  getAppSettings.mockResolvedValue({ settings: {} } as Awaited<ReturnType<typeof configApi.getAppSettings>>)
}

async function selectTestPlayerAndOpenKickDialog() {
  await waitFor(() => expect(screen.getByText('TestPlayer')).toBeInTheDocument(), { timeout: 3000 })
  fireEvent.click(screen.getByText('TestPlayer'))
  await waitFor(() => expect(screen.getAllByText('TestPlayer').length).toBeGreaterThan(1), { timeout: 3000 })
  const kickTile = screen.getAllByText(en.dossier.kickButton)
    .map((el) => el.closest('button'))
    .find((btn): btn is HTMLButtonElement => btn !== null)
  if (!kickTile) throw new Error('Kick tile has no <button> ancestor')
  fireEvent.click(kickTile)
  await screen.findByLabelText(en.kickDialog.reasonLabel)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Players.tsx: Kick dialog warns before the server would silently alter the reason', () => {
  it('shows no note for a reason that survives the server-side rule unchanged', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenKickDialog()

    const reasonInput = screen.getByLabelText(en.kickDialog.reasonLabel)
    fireEvent.change(reasonInput, { target: { value: 'Griefing the base' } })

    expect(screen.queryByText(/will only send/i)).not.toBeInTheDocument()
  })

  it('shows the actual text that will be sent when quotes/symbols would be stripped', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenKickDialog()

    const reasonInput = screen.getByLabelText(en.kickDialog.reasonLabel)
    fireEvent.change(reasonInput, { target: { value: 'griefing "the base"' } })

    await screen.findByText('The server will only send: "griefing the base"')
  })

  it('warns that nothing will be sent when every character would be stripped', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenKickDialog()

    const reasonInput = screen.getByLabelText(en.kickDialog.reasonLabel)
    fireEvent.change(reasonInput, { target: { value: '\u{1F600}\u{1F600}' } })

    await screen.findByText(en.kickDialog.reasonAlteredToEmpty)
  })

  it('the note disappears live once the text is edited back to something the server accepts unchanged', async () => {
    await setUpFixtures()
    renderPlayers()
    await selectTestPlayerAndOpenKickDialog()

    const reasonInput = screen.getByLabelText(en.kickDialog.reasonLabel)
    fireEvent.change(reasonInput, { target: { value: 'griefing "the base"' } })
    await screen.findByText(/will only send/i)

    fireEvent.change(reasonInput, { target: { value: 'griefing the base' } })
    expect(screen.queryByText(/will only send/i)).not.toBeInTheDocument()
  })
})
