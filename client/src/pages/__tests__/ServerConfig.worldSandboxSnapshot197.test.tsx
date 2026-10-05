import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { panelBridgeApi, serverApi, serverFilesApi, serversApi } from '@/lib/api'

// #197: the world save's map_sand.bin holds its own copy of every sandbox
// option, and the game applies it over SandboxVars.lua on every start, so
// changes made on this page or in the in-game admin panel were undone at the
// next restart with nothing on screen saying why. GET /sandbox now reports
// the file; the Sandbox and Mod Settings tabs say so and offer to retire it
// while the server is stopped.

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

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: () => {}, off: () => {} }),
}))

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getStatus = vi.spyOn(serverApi, 'getStatus')
const getComposedStatus = vi.spyOn(serversApi, 'getComposedStatus')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const retire = vi.spyOn(serverFilesApi, 'retireWorldSandboxSnapshot')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

const sections = {
  VERSION: 6,
  settings: {},
  ZombieLore: { Cognition: 3, DoorOpeningPercentage: 0 },
  ZombieConfig: {},
  MultiplierConfig: {},
  Map: {},
  Basement: {},
}

const SNAPSHOT = {
  path: '/opt/zomboid-panel/data/pzserver_Data/Saves/Multiplayer/DoB/map_sand.bin',
  mtime: '2026-10-05T06:58:03.000Z',
}

function mockLoads({ snapshot, running }: { snapshot: boolean; running: boolean }) {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'DoB', serverName: 'DoB', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running } as never)
  getPaths.mockResolvedValue({
    exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
  } as never)
  getSandbox.mockResolvedValue({
    sandbox: sections,
    path: '/x',
    serverName: 'DoB',
    ...(snapshot ? { worldSandboxSnapshot: SNAPSHOT } : {}),
  } as never)
}

function renderTab(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/server-config?tab=${tab}`]}>
      <ConfirmProvider>
        <TooltipProvider>
          <ServerConfig />
        </TooltipProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

// A remote server (SFTP): no process scan, so the page reads RCON and the
// bridge from the composed status, whose host is always "unknown".
function mockRemote({ rcon }: { rcon: 'connected' | 'disconnected' }) {
  mockLoads({ snapshot: true, running: false })
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'DoB', serverName: 'DoB', isRemote: true } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: true } } as never)
  getComposedStatus.mockResolvedValue({
    host: { status: 'unknown' },
    server: { status: rcon },
    bridge: { status: 'inactive' },
  } as never)
}

const TITLE = 'This world keeps its own copy of the sandbox settings'

describe("ServerConfig.tsx: the world's own sandbox copy (#197)", () => {
  it('says the game undoes edits made here, and when the copy was written', async () => {
    mockLoads({ snapshot: true, running: false })
    renderTab('sandbox')

    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    const date = new Date(SNAPSHOT.mtime).toLocaleString('en')
    expect(screen.getByText(new RegExp(`map_sand\\.bin, last written ${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeInTheDocument()
    expect(screen.getByText(/changes made here or in the in-game admin panel are undone/)).toBeInTheDocument()
  })

  it('shows it on the Mod Settings tab too, where live edits are made', async () => {
    mockLoads({ snapshot: true, running: false })
    renderTab('modsettings')

    expect(await screen.findByText(TITLE)).toBeInTheDocument()
  })

  it('shows nothing for a world without the copy', async () => {
    mockLoads({ snapshot: false, running: false })
    renderTab('sandbox')

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('only offers to retire it once the server is stopped', async () => {
    mockLoads({ snapshot: true, running: true })
    renderTab('sandbox')

    await screen.findByText(TITLE)
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Use SandboxVars.lua' })).toBeDisabled()
    expect(screen.getByText('Stop the server first.')).toBeInTheDocument()
  })

  it('retires it after confirmation and drops the banner', async () => {
    mockLoads({ snapshot: true, running: false })
    retire.mockResolvedValue({ success: true, retired: true, movedTo: '/cfg/backups/DoB_map_sand.bin.x.retired' })
    renderTab('sandbox')

    await screen.findByText(TITLE)
    const action = screen.getByRole('button', { name: 'Use SandboxVars.lua' })
    await waitFor(() => expect(action).not.toBeDisabled())
    fireEvent.click(action)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/moved to the backups folder next to SandboxVars\.lua, not deleted/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Use SandboxVars.lua' }))
    })

    await waitFor(() => expect(retire).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
  })

  // A remote server never reads as confirmed stopped (its host is out of
  // the panel's sight), so waiting for that kept the action disabled for good.
  it('offers it on a remote server once RCON and the bridge show it down', async () => {
    mockRemote({ rcon: 'disconnected' })
    renderTab('sandbox')

    await screen.findByText(TITLE)
    await waitFor(() => expect(getComposedStatus).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use SandboxVars.lua' })).not.toBeDisabled())
    expect(screen.queryByText('Stop the server first.')).not.toBeInTheDocument()
  })

  it('holds it back on a remote server while RCON is connected', async () => {
    mockRemote({ rcon: 'connected' })
    renderTab('sandbox')

    await screen.findByText(TITLE)
    await waitFor(() => expect(getComposedStatus).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Use SandboxVars.lua' })).toBeDisabled()
    expect(screen.getByText('Stop the server first.')).toBeInTheDocument()
  })

  // A PanelBridge older than #197 writes map_sand.bin on every live edit,
  // and keeps doing so until the server restarts with the current one.
  it('appears after a live edit on Mod Settings when the world now has the copy', async () => {
    mockLoads({ snapshot: false, running: true })
    const saveOption = vi.spyOn(serverFilesApi, 'saveSandboxOption').mockResolvedValue({
      success: true,
      persisted: true,
      worldSandboxSnapshot: SNAPSHOT,
    })
    const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand').mockImplementation(async (action) => {
      if (action === 'getAllSandboxOptions') {
        return {
          success: true,
          data: {
            options: { General: [{ name: 'General.TestOption', shortName: 'TestOption', tableName: 'General', type: 'boolean', value: false }] },
            groups: [{ name: 'General', count: 1 }],
            totalCount: 1,
            enumerated: true,
          },
        } as never
      }
      // What PanelBridge 1.7.72 answers: it just ran saveGame().
      return { success: true, data: { name: 'General.TestOption', value: true, type: 'boolean', verified: 'confirmed', persisted: true } } as never
    })
    renderTab('modsettings')

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getAllSandboxOptions', {}, expect.anything()))
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'TestOption' } })
    const toggle = await screen.findByRole('switch')
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(toggle)
    })

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption', { name: 'General.TestOption', value: true }))
    await waitFor(() => expect(saveOption).toHaveBeenCalledWith('General.TestOption', true))
    expect(await screen.findByText(TITLE)).toBeInTheDocument()
  })
})
