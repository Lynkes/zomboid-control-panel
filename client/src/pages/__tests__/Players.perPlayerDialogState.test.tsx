import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Players from '../Players'
import { playersApi, panelBridgeApi, configApi } from '@/lib/api'
import en from '../../locales/en/players.json'

// The dossier's dialogs keep their inputs while closed. The teleport dialog
// pinned its target to whoever was selected when it first opened and never let
// go (cancel it for Alice, select Bob: heading "Bob", target and teleport
// "Alice"), and the access-level dialog kept the level last granted, so the
// next player's dialog opened with Set enabled on e.g. "admin". Both now start
// from the selected player again.

// Radix's Select needs layout jsdom doesn't have: a plain <select> with the
// same value/onValueChange contract (same stub as
// Players.lastAdminAccessLevelConfirm.test.tsx).
vi.mock('@/components/ui/select', () => {
  function findId(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (found || !React.isValidElement(child)) return
      const props = child.props as { id?: string; children?: React.ReactNode }
      if (props.id) {
        found = props.id
        return
      }
      found = findId(props.children)
    })
    return found
  }
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    return (
      <select id={findId(children)} value={value} onChange={(e) => onValueChange(e.target.value)}>
        <option value="" disabled></option>
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

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
      teleport: vi.fn(),
      setAccessLevel: vi.fn(),
      voiceBan: vi.fn(),
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

const teleport = vi.mocked(playersApi.teleport)
const setAccessLevel = vi.mocked(playersApi.setAccessLevel)
const voiceBan = vi.mocked(playersApi.voiceBan)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderWithTwoPlayers() {
  vi.mocked(playersApi.getPlayers).mockResolvedValue({
    players: [
      { name: 'Alice', online: true },
      { name: 'Bob', online: true },
    ],
  })
  vi.mocked(playersApi.getWhitelist).mockResolvedValue({ success: true, available: true, accounts: [], allowedSteamIds: [] })
  vi.mocked(playersApi.getPerks).mockResolvedValue({ catalog: [] })
  vi.mocked(playersApi.getAccessLevels).mockResolvedValue({ levels: ['admin', 'moderator', 'user', 'none'], available: true })
  vi.mocked(playersApi.getSteamIdBans).mockResolvedValue({ bans: [] })
  vi.mocked(playersApi.getNotes).mockResolvedValue({ notes: [] })
  vi.mocked(playersApi.getStats).mockResolvedValue({ stats: [] })
  vi.mocked(playersApi.getExports).mockResolvedValue({ exports: [] })
  vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
  teleport.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof playersApi.teleport>>)
  setAccessLevel.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof playersApi.setAccessLevel>>)
  voiceBan.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof playersApi.voiceBan>>)
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: true, isRunning: true } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
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
  await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument(), { timeout: 3000 })
  await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument(), { timeout: 3000 })
}

async function selectPlayer(name: string) {
  // The roster row is the only match until the player is selected.
  fireEvent.click(screen.getAllByText(name)[0])
  await waitFor(() => expect(screen.getByRole('heading', { name })).toBeInTheDocument(), { timeout: 3000 })
}

function tileButton(label: string) {
  const tile = screen.getAllByText(label)
    .map((el) => el.closest('button'))
    .find((btn): btn is HTMLButtonElement => btn !== null)
  if (!tile) throw new Error(`${label} tile has no <button> ancestor`)
  return tile
}

// Teleport sits in the player's "..." menu and Voice ban in the page header's
// "More" menu. Radix opens a DropdownMenuTrigger on pointerdown.
async function openMenuDialog(triggerName: string, item: string | RegExp) {
  const trigger = screen.getByRole('button', { name: triggerName })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: item }))
  return screen.findByRole('dialog')
}
const openTeleport = () => openMenuDialog('More player actions', 'Teleport…')
const openVoiceBan = () => openMenuDialog('More actions', /^Voice ban…/)

async function openDialog(label: string) {
  fireEvent.click(tileButton(label))
  return screen.findByRole('dialog')
}

async function cancelDialog() {
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe('Players.tsx: the teleport dialog follows the selected player', () => {
  it('after cancelling it for Alice, selecting Bob opens it on Bob and teleports Bob', async () => {
    await renderWithTwoPlayers()
    await selectPlayer('Alice')

    const first = await openTeleport()
    expect(within(first).getByLabelText(en.teleportDialog.targetLabel)).toHaveValue('Alice')
    await cancelDialog()

    await selectPlayer('Bob')
    const second = await openTeleport()
    expect(within(second).getByLabelText(en.teleportDialog.targetLabel)).toHaveValue('Bob')
    expect(within(second).getByText(/Bob/, { selector: 'p' })).toBeInTheDocument()

    fireEvent.change(within(second).getByLabelText(en.teleportDialog.xLabel), { target: { value: '100' } })
    fireEvent.change(within(second).getByLabelText(en.teleportDialog.yLabel), { target: { value: '200' } })
    fireEvent.click(within(second).getByRole('button', { name: en.teleportDialog.submit }))

    await waitFor(() => expect(teleport).toHaveBeenCalledTimes(1))
    expect(teleport).toHaveBeenCalledWith('Bob', { x: 100, y: 200, z: 0 })
  })

  it('a target typed over the player in a dialog that is then cancelled is not kept', async () => {
    await renderWithTwoPlayers()
    await selectPlayer('Alice')

    const first = await openTeleport()
    fireEvent.change(within(first).getByLabelText(en.teleportDialog.targetLabel), { target: { value: 'SomeoneElse' } })
    await cancelDialog()

    const second = await openTeleport()
    expect(within(second).getByLabelText(en.teleportDialog.targetLabel)).toHaveValue('Alice')
  })
})

describe('Players.tsx: the access-level dialog does not carry a level over to the next player', () => {
  it('opens on the placeholder with Set disabled for Bob after admin was granted to Alice', async () => {
    await renderWithTwoPlayers()
    await selectPlayer('Alice')

    const first = await openDialog(en.actionTiles.accessLevelLabel)
    fireEvent.change(within(first).getByLabelText(en.accessLevelDialog.label), { target: { value: 'admin' } })
    fireEvent.click(within(first).getByRole('button', { name: en.accessLevelDialog.submit }))
    await waitFor(() => expect(setAccessLevel).toHaveBeenCalledWith('Alice', 'admin', false))
    await cancelDialog()

    await selectPlayer('Bob')
    const second = await openDialog(en.actionTiles.accessLevelLabel)
    expect(within(second).getByLabelText(en.accessLevelDialog.label)).toHaveValue('')
    expect(within(second).getByRole('button', { name: en.accessLevelDialog.submit })).toBeDisabled()
  })
})

describe('Players.tsx: the voice-ban dialog does not carry a typed name over to the next player', () => {
  it('shows the newly selected player, not the name typed for the previous one', async () => {
    await renderWithTwoPlayers()
    await selectPlayer('Alice')

    const first = await openVoiceBan()
    fireEvent.change(within(first).getByPlaceholderText(en.voiceBanDialog.usernamePlaceholder), { target: { value: 'Mallory' } })
    await cancelDialog()

    await selectPlayer('Bob')
    const second = await openVoiceBan()
    expect(within(second).getByPlaceholderText(en.voiceBanDialog.usernamePlaceholder)).toHaveValue('Bob')
  })
})
