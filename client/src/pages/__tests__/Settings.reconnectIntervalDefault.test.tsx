import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi } from '@/lib/api'
import i18n from '@/i18n'

// Settings > Connection > "Reconnect interval" is applied by the RCON service
// in the range 5-600 s, and the background loop always used 60 s before the
// setting existed. The page used to default the field to 5 and send its whole
// state on every save, so the first save after upgrading moved an install that
// never touched the setting from 60 s to 5 s; the input and the route also
// allowed 1-60 while the service runs a 1-4 as 5 and accepts up to 600.

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

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)

function createFakeSocket() {
  return { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
  updateAppSettings.mockResolvedValue({ success: true, message: 'Settings saved' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function renderSettings(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <SocketContext.Provider value={createFakeSocket()}>
        <TooltipProvider>
          <Routes>
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

describe('Settings: reconnect interval', () => {
  it('sends 60 s, the interval the loop always used, when an install that never saved it saves something else', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    renderSettings('/settings')

    const portInput = await screen.findByLabelText('Panel Port')
    await waitFor(() => expect(portInput).toHaveValue(3001))
    fireEvent.change(portInput, { target: { value: '3002' } })
    const save = await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: 'Save Changes' })
      expect(buttons[0]).toBeEnabled()
      return buttons[0]
    })
    fireEvent.click(save)

    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledTimes(1))
    expect(updateAppSettings.mock.calls[0][0]).toMatchObject({ panelPort: '3002', reconnectInterval: '60' })
  })

  it('shows 60 s for a never-saved install and offers the same 5-600 range the server applies', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    renderSettings('/settings?tab=connection')

    const input = await screen.findByLabelText('Reconnect Interval (seconds)')
    expect(input).toHaveValue(60)
    expect(input).toHaveAttribute('min', '5')
    expect(input).toHaveAttribute('max', '600')
  })

  it('keeps an interval that was saved', async () => {
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001', autoReconnect: true, reconnectInterval: '30' } })
    renderSettings('/settings?tab=connection')

    const input = await screen.findByLabelText('Reconnect Interval (seconds)')
    await waitFor(() => expect(input).toHaveValue(30))
  })
})
