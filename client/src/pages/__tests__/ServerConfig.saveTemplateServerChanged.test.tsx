import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// pz-bughunt round 18 (the narrower server-switch races flagged in round
// 17): handleSaveTemplate calls serverFilesApi.saveAsTemplate({name,
// description, includeIni, includeSandbox}) -- no ini/sandbox VALUES sent,
// the server reads whatever's currently on disk for "the active server" at
// save time, with no id sent. If the active server changed while the
// Save-as-Template dialog stayed open, the resulting template (named while
// looking at server A) would actually capture server B's live config. Same
// serverChangedSinceLoad guard as handleSaveIni/handleSaveSandbox.

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
const getSpawnRegions = vi.spyOn(serverFilesApi, 'getSpawnRegions')
const getTemplates = vi.spyOn(serverFilesApi, 'getTemplates')
const saveAsTemplate = vi.spyOn(serverFilesApi, 'saveAsTemplate')

const allPaths = {
  exists: { ini: true, sandbox: false, spawnpoints: true, spawnregions: true },
} as never

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
  localStorage.clear()
})

function renderServerConfig() {
  return render(
    <MemoryRouter initialEntries={['/server-config']}>
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
  getTemplates.mockResolvedValue({ templates: [] } as never)
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

describe('ServerConfig.tsx: Save as Template also blocks once the active server changed', () => {
  it('handleSaveTemplate refuses to save after the active server changed', async () => {
    mockCommonLoads()
    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    await makeServerChangedSinceLoadTrue()

    fireEvent.click(screen.getByRole('button', { name: /saved configs/i }))
    const templatesDialog = await screen.findByRole('dialog')
    fireEvent.click(within(templatesDialog).getByRole('button', { name: /save current config/i }))

    const saveDialog = await screen.findByRole('dialog', { name: /save current config/i })
    const nameInput = within(saveDialog).getByPlaceholderText(/pve casual/i)
    fireEvent.change(nameInput, { target: { value: 'My Template' } })

    const saveButton = within(saveDialog).getByRole('button', { name: /^save config$/i })
    expect(saveButton).toBeDisabled()

    fireEvent.click(saveButton)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saveAsTemplate).not.toHaveBeenCalled()
  })
})
