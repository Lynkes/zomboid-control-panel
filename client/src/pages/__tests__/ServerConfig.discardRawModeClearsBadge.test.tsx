import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverApi, serverFilesApi, serversApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 22, flagged in round 21 and left out of scope
// there): hasIniChanges compares rawContent against originalRawContent
// while editorMode === 'raw' (a separate tracked-changes signal from
// iniSettings), but discardIniChanges()/discardSandboxChanges() only ever
// reset the STRUCTURED state (iniSettings/sandboxData) -- so clicking
// Discard while in the raw editor left the textarea's edited content in
// place and the "Unsaved changes" badge still showing, i.e. Discard
// silently did nothing visible in raw mode.

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

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const saveIni = vi.spyOn(serverFilesApi, 'saveIni')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getStatus = vi.spyOn(serverApi, 'getStatus')

const emptyPaths = {
  exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
} as never

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderServerConfig() {
  return render(
    <MemoryRouter>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: Discard in raw mode clears the raw textarea and the Unsaved changes badge', () => {
  it('restores the original raw content and hides the badge when Discard is clicked', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue(emptyPaths)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
    getRaw.mockResolvedValue({ content: 'PVP=false' } as never)
    getStatus.mockResolvedValue({ running: false } as never)

    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getStatus).toHaveBeenCalled())

    const rawToggles = await screen.findAllByRole('button', { name: /raw/i })
    await act(async () => { fireEvent.click(rawToggles[0]) })
    await waitFor(() => expect(getRaw).toHaveBeenCalled())
    const textarea = await screen.findByRole('textbox')
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'PVP=true\nedited=true' } })
    })

    await screen.findByText('Unsaved changes')

    const discardButton = await screen.findByRole('button', { name: /discard/i })
    fireEvent.click(discardButton)

    await waitFor(() => expect(textarea).toHaveValue('PVP=false'))
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(saveIni).not.toHaveBeenCalled()
  })
})
