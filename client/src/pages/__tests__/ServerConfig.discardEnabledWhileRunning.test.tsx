import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverApi, serverFilesApi, serversApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 21, UX follow-up, commit 14fed308's own
// original question): discardIniChanges()/discardSandboxChanges() (the
// sticky save bar's "Discard" button) only reassign LOCAL React state back
// to originalIniSettings/originalSandboxData -- neither one calls the
// server at all. The button was nonetheless disabled whenever
// serverMayBeRunning was true, the same guard the Save button correctly
// uses (Save genuinely writes to the server, so a running server matters
// there) -- making it impossible for an operator to back out an unsaved
// edit for exactly the reason they most want to: the server turned out to
// be running while they were mid-edit.

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

describe('ServerConfig.tsx: Discard is not gated on serverMayBeRunning (it never calls the server)', () => {
  it('stays enabled while the server may be running, and clicking it does not attempt a save', async () => {
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue(emptyPaths)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
    getRaw.mockResolvedValue({ content: 'PVP=false' } as never)
    // Native provider, running: true -- serverRunning resolves true, so
    // serverMayBeRunning (serverRunning !== false) is true too.
    getStatus.mockResolvedValue({ running: true } as never)

    renderServerConfig()
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))
    // Let refreshServerState's own fetch land before asserting on its result.
    await waitFor(() => expect(getStatus).toHaveBeenCalled())

    const rawToggles = await screen.findAllByRole('button', { name: /raw/i })
    await act(async () => { fireEvent.click(rawToggles[0]) })
    await waitFor(() => expect(getRaw).toHaveBeenCalled())
    const textarea = await screen.findByRole('textbox')
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'PVP=true\nedited=true' } })
    })

    await screen.findByText('Unsaved changes')
    // This is the round's actual fix under test: Discard must stay enabled
    // regardless of serverMayBeRunning, since it never calls the server.
    // (Separately: raw-mode discard not clearing the "Unsaved changes"
    // badge, flagged here in round 21, was fixed in round 22 -- see
    // ServerConfig.discardRawModeClearsBadge.test.tsx.)
    const discardButton = await screen.findByRole('button', { name: /discard/i })
    expect(discardButton).not.toBeDisabled()

    fireEvent.click(discardButton)
    expect(saveIni).not.toHaveBeenCalled()
  })
})
