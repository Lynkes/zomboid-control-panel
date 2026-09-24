import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi } from '@/lib/api'

// pz-bughunt round 17 (every write that trusts the server-side active
// server): ServerConfig.activeServerChangedGuard.test.tsx already locks in
// the reference guard (serverChangedSinceLoad) for handleSaveIni/
// handleSaveSandbox. Four more write actions on this same page shared the
// identical no-server-id shape but never checked that flag: handleOptionChange
// (the "Mod Settings" tab's live per-option edit -- worst of the four, since
// it both live-edits via RCON AND persists to disk), handleSaveSpawnPoints,
// handleSaveSpawnRegions, and handleRestoreBackup. Each locked in here with
// its own focused case, same guard, same toast.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    on: (event: string, handler: () => void) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
      socketHandlers.get(event)!.add(handler)
    },
    off: (event: string, handler: () => void) => {
      socketHandlers.get(event)?.delete(handler)
    },
  }),
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const getSpawnPoints = vi.spyOn(serverFilesApi, 'getSpawnPoints')
const saveSpawnPoints = vi.spyOn(serverFilesApi, 'saveSpawnPoints')
const getSpawnRegions = vi.spyOn(serverFilesApi, 'getSpawnRegions')
const saveSpawnRegions = vi.spyOn(serverFilesApi, 'saveSpawnRegions')
const getBackups = vi.spyOn(serverFilesApi, 'getBackups')
const restoreBackup = vi.spyOn(serverFilesApi, 'restoreBackup')
const saveSandboxOption = vi.spyOn(serverFilesApi, 'saveSandboxOption')
const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand')

const allPaths = {
  exists: { ini: true, sandbox: false, spawnpoints: true, spawnregions: true },
} as never

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
  localStorage.clear()
})

function renderServerConfig(initialEntries = ['/server-config']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider>
        <ServerConfig />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

function mockCommonLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
  getPaths.mockResolvedValue(allPaths)
  getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
  getRaw.mockResolvedValue({ content: 'PVP=false', path: '/a', filename: 'server.ini' } as never)
  getSpawnPoints.mockResolvedValue({ spawnpoints: { Fireman: [] }, path: '/a' } as never)
  getSpawnRegions.mockResolvedValue({ spawnregions: [{ name: 'Riverside', file: 'media/maps/Riverside.tmx' }], path: '/a' } as never)
}

// Common to three of the four cases: dirty the ini tab (via the raw-editor
// escape hatch, same as ServerConfig.activeServerChangedGuard.test.tsx) and
// fire activeServerChanged so serverChangedSinceLoad flips true -- proven
// already to happen correctly by that sibling test file.
// Radix's TabsTrigger activates on mousedown (button === 0), not click --
// see @radix-ui/react-tabs's TabsTrigger onMouseDown -- so a plain
// fireEvent.click never switches tabs here.
function clickTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

async function makeServerChangedSinceLoadTrue() {
  const rawToggles = await screen.findAllByRole('button', { name: /raw/i })
  await act(async () => { fireEvent.click(rawToggles[0]) })
  await waitFor(() => expect(getRaw).toHaveBeenCalled())
  const textarea = await screen.findByRole('textbox')
  await act(async () => {
    fireEvent.change(textarea, { target: { value: 'PVP=true\nedited=true' } })
  })
  act(() => { emitActiveServerChanged() })
  expect(await screen.findByText('Active server changed')).toBeInTheDocument()
}

describe('ServerConfig.tsx: the remaining write actions also block once the active server changes', () => {
  it('handleSaveSpawnPoints refuses to save after the active server changed', async () => {
    mockCommonLoads()
    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    await makeServerChangedSinceLoadTrue()

    clickTab(/spawn points/i)
    await waitFor(() => expect(getRaw).toHaveBeenCalledWith('spawnpoints'))
    const saveButton = await screen.findByRole('button', { name: /^save$/i })
    expect(saveButton).toBeDisabled()

    fireEvent.click(saveButton)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saveSpawnPoints).not.toHaveBeenCalled()
  })

  it('handleSaveSpawnRegions refuses to save after the active server changed', async () => {
    mockCommonLoads()
    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    await makeServerChangedSinceLoadTrue()

    clickTab(/spawn regions/i)
    await waitFor(() => expect(getRaw).toHaveBeenCalledWith('spawnregions'))
    const saveButton = await screen.findByRole('button', { name: /^save$/i })
    expect(saveButton).toBeDisabled()

    fireEvent.click(saveButton)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saveSpawnRegions).not.toHaveBeenCalled()
  })

  it('handleRestoreBackup refuses to restore after the active server changed', async () => {
    mockCommonLoads()
    getBackups.mockResolvedValue({
      backups: [{ filename: 'server_2026-09-18.ini.bak', size: 512, created: '2026-09-18T00:00:00.000Z' }],
      path: '/a',
    } as never)
    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    await makeServerChangedSinceLoadTrue()

    fireEvent.click(screen.getByRole('button', { name: /backups/i }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(getBackups).toHaveBeenCalled())
    const restoreButton = await within(dialog).findByRole('button', { name: /restore/i })
    expect(restoreButton).toBeDisabled()

    fireEvent.click(restoreButton)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The guard sits before the confirm() prompt too -- neither the confirm
    // dialog nor the API call should ever be reached.
    expect(restoreBackup).not.toHaveBeenCalled()
  })

  it('handleOptionChange refuses to live-edit and persist a Mod Settings option after the active server changed', async () => {
    mockCommonLoads()
    sendCommand.mockResolvedValue({
      success: true,
      data: {
        options: { General: [{ name: 'General.TestOption', shortName: 'TestOption', tableName: 'General', type: 'boolean', value: false }] },
        groups: [{ name: 'General', count: 1 }],
        totalCount: 1,
        enumerated: true,
      },
    } as never)
    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    await makeServerChangedSinceLoadTrue()

    clickTab(/mod settings/i)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getAllSandboxOptions', {}, expect.anything()))
    // Mod groups render collapsed by default -- searching auto-expands any
    // matching group (isFiltering), same as a real operator would use to
    // find a specific option instead of scrolling every group open.
    const searchBox = await screen.findByPlaceholderText(/search/i)
    fireEvent.change(searchBox, { target: { value: 'TestOption' } })
    const toggle = await screen.findByRole('switch')

    fireEvent.click(toggle)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Only the initial getAllSandboxOptions enumeration call -- never a
    // second call for setSandboxOption.
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(saveSandboxOption).not.toHaveBeenCalled()
  })
})
