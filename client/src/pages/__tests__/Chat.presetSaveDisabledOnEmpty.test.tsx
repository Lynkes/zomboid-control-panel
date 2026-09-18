import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Chat from '../Chat'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

// UX sense-check 2026-09-18 (operator ask: "looks unfinished" / inconsistent
// affordances): the "add a new quick broadcast" control already disables
// itself while its input is empty (`!newPresetDraft.trim() ||
// !canManagePresets`), so a first-time operator learns "empty input ->
// greyed-out button" as this panel's rule. The "edit an existing quick
// broadcast" Save (checkmark) button broke that rule -- it only disabled on
// `!canManagePresets`, never on an empty/whitespace-only draft, even though
// handleSaveEdit's own body silently no-ops on that same condition
// (`if (!trimmed) return`). Clearing a preset's text and hitting the
// checkmark therefore looked live (not greyed out, no error) but did
// nothing -- exactly the "looks unfinished" / "doesn't know what to do
// next" pattern the operator asked to hunt for. Fix: Save's disabled
// expression now also checks `!editingDraft.trim()`, matching Add's
// existing pattern. This test fails against the pre-fix disabled expression
// (`disabled={!canManagePresets}` alone) because the Save button would stay
// enabled with an empty draft.
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
    panelBridgeApi: { ...actual.panelBridgeApi, getChatInfo: vi.fn() },
  }
})

const getPlayers = vi.mocked(playersApi.getPlayers)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
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

async function setUp() {
  getPlayers.mockResolvedValue({ players: [] } as Awaited<ReturnType<typeof playersApi.getPlayers>>)
  getAppSettings.mockResolvedValue({ chatPresets: ['Existing preset'] } as unknown as Awaited<ReturnType<typeof configApi.getAppSettings>>)
  getChatInfo.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof panelBridgeApi.getChatInfo>>)
}

describe('Chat.tsx: editing a quick broadcast disables Save on an empty draft, matching Add', () => {
  it('disables Save (and never calls the API) when the edit draft is cleared to empty', async () => {
    await setUp()
    renderChat()

    await screen.findByText('Existing preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit quick broadcasts' }))
    fireEvent.click(screen.getByText('Existing preset'))

    const editInput = screen.getByDisplayValue('Existing preset')
    fireEvent.change(editInput, { target: { value: '   ' } })

    const saveButton = screen.getByLabelText('Save')
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)
    fireEvent.keyDown(editInput, { key: 'Enter' })

    expect(updateAppSettings).not.toHaveBeenCalled()
  })

  it('re-enables Save once the draft has real text again, and persists it', async () => {
    await setUp()
    updateAppSettings.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof configApi.updateAppSettings>>)
    renderChat()

    await screen.findByText('Existing preset')
    fireEvent.click(screen.getByRole('button', { name: 'Edit quick broadcasts' }))
    fireEvent.click(screen.getByText('Existing preset'))

    const editInput = screen.getByDisplayValue('Existing preset')
    fireEvent.change(editInput, { target: { value: 'Updated preset' } })

    const saveButton = screen.getByLabelText('Save')
    expect(saveButton).not.toBeDisabled()
    fireEvent.click(saveButton)

    expect(updateAppSettings).toHaveBeenCalledWith({ chatPresets: ['Updated preset'] })
  })
})
