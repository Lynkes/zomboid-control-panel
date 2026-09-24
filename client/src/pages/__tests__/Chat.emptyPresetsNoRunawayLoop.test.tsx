import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 22, flagged in round 21 and left out of scope
// there): the settings-load effect depends on [defaultPresets], and
// defaultPresets = t('presets.default', { returnObjects: true }) is a
// BRAND NEW array on every single render (i18next's returnObjects always
// shallow-copies, never caches -- see translate()'s `const copy = ...`).
// Whenever saved chatPresets is empty, the effect falls back to
// setPresets(defaultPresets) -- a different reference every time -- so
// React never bails out, recomputing defaultPresets, re-firing the effect,
// forever. (A non-empty saved list never hung: setPresets(saved) passes
// back the same settings-response reference each call, so React bails out
// after the first update.) Sending a chat message is what actually
// triggered the observable hang, because that's the first user action
// wrapped in fireEvent's act() after mount -- that's where React finally
// gets to process the queued update and discovers it can never settle.

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

Element.prototype.scrollIntoView = vi.fn()

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
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendToServerChat: vi.fn(),
      sendToAdminChat: vi.fn(),
      sendToGeneralChat: vi.fn(),
      getChatInfo: vi.fn(),
    },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const sendToServerChat = vi.mocked(panelBridgeApi.sendToServerChat)
const getChatInfo = vi.mocked(panelBridgeApi.getChatInfo)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChat() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Chat />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

describe('Chat.tsx: an empty saved chatPresets list does not cause a runaway settings-reload loop', () => {
  it('settles after loading, and sending a message on the default (server) channel does not hang', async () => {
    getPlayers.mockResolvedValue({ players: [] } as Awaited<ReturnType<typeof playersApi.getPlayers>>)
    getAppSettings.mockResolvedValue({ chatPresets: [] } as unknown as Awaited<ReturnType<typeof configApi.getAppSettings>>)
    getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)
    sendToServerChat.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof panelBridgeApi.sendToServerChat>>)

    renderChat()

    await waitFor(() => expect(getAppSettings).toHaveBeenCalled())

    const input = await screen.findByRole('textbox', { name: 'Chat message' })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sendToServerChat).toHaveBeenCalledWith('hello', false))

    // The runaway version of this effect calls getAppSettings again on
    // every render it triggers -- pinning this to a small bound is what a
    // hand-revert of the useMemo fix turns into a timeout failure instead
    // of a silent pass.
    expect(getAppSettings.mock.calls.length).toBeLessThanOrEqual(3)
  }, 8000)
})
