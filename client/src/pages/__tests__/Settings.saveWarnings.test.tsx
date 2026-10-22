import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi } from '@/lib/api'
import i18n from '@/i18n'

// PUT /api/config/app-settings answers { success: true, warnings: [...] }
// when the settings were saved but the server manager, the RCON service or
// the CORS rules failed to reload. Settings showed the plain green "Settings
// Saved" and dropped the warnings, so nobody learned a restart was needed.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
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

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)

function createFakeSocket() {
  return { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
  getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('en')
})

async function saveAnEdit(languageAtSave = 'en') {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <SocketContext.Provider value={createFakeSocket()}>
        <TooltipProvider>
          <Routes>
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
  const portInput = await screen.findByLabelText('Panel Port')
  await waitFor(() => expect(portInput).toHaveValue(3001))
  fireEvent.change(portInput, { target: { value: '3002' } })
  const save = await waitFor(() => {
    const buttons = screen.getAllByRole('button', { name: 'Save Changes' })
    expect(buttons[0]).toBeEnabled()
    return buttons[0]
  })
  // The toast is worded when it is shown, in the language then active.
  await i18n.changeLanguage(languageAtSave)
  fireEvent.click(save)
  await waitFor(() => expect(toastMock).toHaveBeenCalled())
  return toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as { title: string; description: string; variant: string }
}

describe('Settings: saving shows what the server could not apply', () => {
  it('shows a warning toast listing the reload warnings the server returned', async () => {
    updateAppSettings.mockResolvedValue({
      success: true,
      message: 'Settings saved',
      warnings: [
        'Server manager failed to reload — restart may be required',
        'CORS settings could not be reloaded — panel restart may be required',
      ],
    })
    const toast = await saveAnEdit()
    expect(toast.variant).toBe('warning')
    expect(toast.title).toBe('Settings Saved, With Warnings')
    expect(toast.description).toContain('Server manager failed to reload — restart may be required')
    expect(toast.description).toContain('CORS settings could not be reloaded — panel restart may be required')
  })

  it('translates the title and the sentence around the warnings', async () => {
    updateAppSettings.mockResolvedValue({ success: true, warnings: ['RCON service failed to reload — reconnect may be required'] })
    const toast = await saveAnEdit('fr')
    expect(toast.variant).toBe('warning')
    expect(toast.title).toBe('Paramètres enregistrés, avec des avertissements')
    expect(toast.description).toContain('RCON service failed to reload — reconnect may be required')
  })

  it('keeps the plain green toast when the save came back clean', async () => {
    updateAppSettings.mockResolvedValue({ success: true, message: 'Settings saved' })
    const toast = await saveAnEdit()
    expect(toast.variant).toBe('success')
    expect(toast.title).toBe('Settings Saved')
  })
})
