import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi } from '@/lib/api'

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true, isAuthenticated: true, isLoading: false,
    needsSetup: false, logout: vi.fn(), getToken: () => 'test-token', can: () => true,
  }),
}))
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: vi.fn(), off: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Mod Settings enum values', () => {
  it('displays and submits the one-based value used by B42 sandbox enums', async () => {
    // jsdom has no layout; Radix scrolls the focused item when opening a Select.
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    try {
      vi.spyOn(serversApi, 'getResolvedActive').mockResolvedValue({
        server: { id: 's1', name: 'Test Server', serverName: 'test', isRemote: false },
      } as never)
      vi.spyOn(serversApi, 'getActive').mockResolvedValue({ server: null } as never)
      vi.spyOn(serverFilesApi, 'getPaths').mockResolvedValue({
        exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
      } as never)
      const getIni = vi.spyOn(serverFilesApi, 'getIni').mockResolvedValue({
        settings: { PVP: 'false' }, path: '/test', serverName: 'test',
      } as never)
      const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand')
      sendCommand.mockResolvedValueOnce({ success: true, data: {
        options: { General: [{ name: 'General.TestOption', shortName: 'TestOption',
          tableName: 'General', type: 'enum', value: 2, selectedIndex: 2,
          enumValues: ['Never', 'Instant', 'Delayed'] }] },
        groups: [{ name: 'General', count: 1 }], totalCount: 1, enumerated: true,
      } } as never).mockResolvedValue({ success: true, data: {
        name: 'General.TestOption', value: 3, type: 'enum', verified: true, persisted: true,
      } } as never)

      render(<MemoryRouter initialEntries={['/server-config']}>
        <TooltipProvider><ServerConfig /></TooltipProvider>
      </MemoryRouter>)
      await waitFor(() => expect(getIni).toHaveBeenCalled())
      fireEvent.mouseDown(screen.getByRole('tab', { name: /mod settings/i }), { button: 0 })
      await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getAllSandboxOptions', {}, expect.anything()))
      fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'TestOption' } })
      const select = await screen.findByRole('combobox')
      expect(select).toHaveTextContent('Instant')
      fireEvent.keyDown(select, { key: 'ArrowDown' })
      fireEvent.click(await screen.findByRole('option', { name: 'Delayed' }))
      await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
        { name: 'General.TestOption', value: 3 }))
      expect(select).toHaveTextContent('Delayed')
    } finally {
      if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })
})
