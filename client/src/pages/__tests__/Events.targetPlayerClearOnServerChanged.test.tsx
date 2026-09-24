import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'
import enEvents from '../../locales/en/events.json'

// bug-hunt-2026-09-18 (round 20): spawnHordeNear/spawnHordeBehind,
// clearZombiesNearPlayer, and the teleport commands all target whichever
// player name is held in `selectedPlayer` -- a page-level Select the
// operator picks once, not re-derived per click. activeServerChanged
// already refreshed the ROSTER (fetchPlayers) but never touched this
// separately-held SELECTION: a name picked from the OLD server's roster
// stayed selected across a switch. If the new server happens to have a
// different real player by the same name, an action fired right after the
// switch would silently target THEM, not the person the operator actually
// chose. Fixed by clearing selectedPlayer on activeServerChanged -- every
// action that reads it already disables itself on `!selectedPlayer`.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

// Same jsdom-Radix-Select workaround as Events.safehouseAddPlayerPicker.test.tsx/
// Events.vehicleSirenControl.test.tsx: a real pointer interaction on a Radix
// Select throws in jsdom. Swap the picker for a native <select>, which
// drives the same onValueChange.
vi.mock('@/components/ui/select', () => {
  function findAriaLabel(children: React.ReactNode): string | undefined {
    let found: string | undefined
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const label = (child.props as { 'aria-label'?: string })['aria-label']
      if (label) found = label
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
  function Select({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
    return (
      <select
        aria-label={findAriaLabel(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
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

// bug-hunt-2026-09-18 (round 19): Events.tsx now calls useAuth() to gate its
// players.endanger_or_impersonate-only controls -- default to a fully
// permitted role.
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
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), spawnHordeNear: vi.fn() },
  }
})

// Same stable-identity fake socket as Events.activeServerRaceOrder.test.tsx.
const socketHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getPlayers = vi.mocked(playersApi.getPlayers)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const spawnHordeNear = vi.mocked(panelBridgeApi.spawnHordeNear)

function renderEvents() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openHordeSection() {
  fireEvent.click(await screen.findByText(enEvents.sections.horde.label))
}

function pickSpecificPlayerTarget() {
  fireEvent.click(screen.getByText(enEvents.statusBar.specific))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Events.tsx: a selected player target does not survive an active-server switch', () => {
  it('clears the selected target and disables player-targeted actions once the server changes', async () => {
    getBridgeStatus.mockResolvedValue({ modConnected: true } as never)
    getPlayers.mockResolvedValueOnce({ players: [{ name: 'Kate', online: true }] } as never)
    spawnHordeNear.mockResolvedValue({ success: true } as never)

    renderEvents()
    await openHordeSection()
    pickSpecificPlayerTarget()

    const targetSelect = await screen.findByLabelText(enEvents.statusBar.selectPlayerAria)
    fireEvent.change(targetSelect, { target: { value: 'Kate' } })
    expect(targetSelect).toHaveValue('Kate')

    const hordeButton = screen.getByRole('button', { name: new RegExp(enEvents.horde.spawnNear.split('{{')[0].trim()) })
    expect(hordeButton).not.toBeDisabled()

    // The active server switches elsewhere. The new server's roster still
    // happens to include a player literally named "Kate" -- a different
    // real person -- which is exactly the case this test must catch: the
    // stale selection surviving would silently target them.
    getPlayers.mockResolvedValueOnce({ players: [{ name: 'Kate', online: true }] } as never)
    await act(async () => { emitActiveServerChanged() })

    expect(targetSelect).toHaveValue('')
    expect(hordeButton).toBeDisabled()

    fireEvent.click(hordeButton)
    expect(spawnHordeNear).not.toHaveBeenCalled()
  })

  it('does not clear the target when nothing changed (no false reset)', async () => {
    getBridgeStatus.mockResolvedValue({ modConnected: true } as never)
    getPlayers.mockResolvedValue({ players: [{ name: 'Kate', online: true }] } as never)
    spawnHordeNear.mockResolvedValue({ success: true } as never)

    renderEvents()
    await openHordeSection()
    pickSpecificPlayerTarget()

    const targetSelect = await screen.findByLabelText(enEvents.statusBar.selectPlayerAria)
    fireEvent.change(targetSelect, { target: { value: 'Kate' } })
    expect(targetSelect).toHaveValue('Kate')

    const hordeButton = screen.getByRole('button', { name: new RegExp(enEvents.horde.spawnNear.split('{{')[0].trim()) })
    expect(hordeButton).not.toBeDisabled()
  })
})
