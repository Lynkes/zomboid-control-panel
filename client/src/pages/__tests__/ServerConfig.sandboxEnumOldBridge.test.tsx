import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi } from '@/lib/api'

// Enum values run 1..N and the bridge sends N as `max`. After a panel update,
// a game server that hasn't restarted still runs the old PanelBridge Lua,
// which read labels from index 0 (the game rejects it), never asked for N,
// and dropped labels without a translation. Its list is shorter than max, and
// label i no longer means value i, so Mod Settings edits the number instead.

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

async function openModSettings(option: Record<string, unknown>) {
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
  const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand').mockImplementation(async (action, args) => {
    if (action === 'getAllSandboxOptions') {
      return { success: true, data: {
        options: { General: [{ name: 'General.TestOption', shortName: 'TestOption',
          tableName: 'General', type: 'enum', ...option }] },
        groups: [{ name: 'General', count: 1 }], totalCount: 1, enumerated: true,
      } } as never
    }
    const value = (args as { value?: unknown } | undefined)?.value
    return { success: true, data: {
      name: 'General.TestOption', value, type: 'enum', verified: 'confirmed', persisted: true,
    } } as never
  })

  render(<MemoryRouter initialEntries={['/server-config']}>
    <TooltipProvider><ServerConfig /></TooltipProvider>
  </MemoryRouter>)
  await waitFor(() => expect(getIni).toHaveBeenCalled())
  fireEvent.mouseDown(screen.getByRole('tab', { name: /mod settings/i }), { button: 0 })
  await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getAllSandboxOptions', {}, expect.anything()))
  fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'TestOption' } })
  return sendCommand
}

describe('Mod Settings enum rows when the labels do not cover 1..max', () => {
  it('keeps the list when the bridge sends one label per value', async () => {
    await openModSettings({
      value: 3, selectedIndex: 3, min: 1, max: 3, enumValues: ['Never', 'Instant', 'Delayed'],
    })

    const select = await screen.findByRole('combobox', { name: 'Test Option' })
    expect(select).toHaveTextContent('Delayed')
    expect(screen.queryByText(/older PanelBridge/i)).not.toBeInTheDocument()
  })

  it('edits the number and says to restart when an old bridge left the last value out', async () => {
    // The old Lua listed labels for 1..N-1 only, so value 3 had no list item.
    const sendCommand = await openModSettings({
      value: 2, selectedIndex: 2, min: 1, max: 3, enumValues: ['Never', 'Instant'],
    })

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    expect(screen.queryByRole('combobox', { name: 'Test Option' })).not.toBeInTheDocument()
    expect(input).toHaveValue(2)
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '3')
    expect(input).toHaveAttribute('step', '1')
    expect(screen.getByText(/older PanelBridge/i)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.blur(input)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
      { name: 'General.TestOption', value: 3 }))
  })

  it('edits the number without the restart hint past the bridge label cap', async () => {
    // A current bridge lists at most 50 labels, so values 51..60 have no item.
    await openModSettings({
      value: 55, selectedIndex: 55, min: 1, max: 60,
      enumValues: Array.from({ length: 50 }, (_, i) => `Label ${i + 1}`),
    })

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    expect(input).toHaveValue(55)
    expect(screen.queryByText(/older PanelBridge/i)).not.toBeInTheDocument()
  })
})
