import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// UX sense-check, 2026-09-18 (first-time-operator pass on ServerConfig.tsx):
// handleSaveSandbox's own comment says a sandbox write has NO RCON
// live-reload path -- "Sandbox settings have no RCON live-reload path...
// this never attempts a live reload and never claims one succeeded" -- a
// sandbox change always needs a server restart to reach the running game,
// confirmed by the toast it actually shows on success
// (toasts.savedRestartToApply, "Saved. Restart the server to apply
// changes."). But both the Sandbox tab's own toolbar Save button and the
// shared sticky unsaved-changes bar rendered the literal label
// "Save & reload" for the Sandbox tab too -- reusing the INI tab's label
// verbatim, where a live RCON reload genuinely is attempted. A first-time
// operator clicking "Save & reload" on the Sandbox tab has no way to know
// the "& reload" half of that promise never happens; the button lies about
// what it does (the operator's own "button labels that don't say what the
// button actually does" complaint). Fixed by giving the Sandbox tab's Save
// controls the plain "Save" label already used by the Spawn Points/Spawn
// Regions tabs, which have the same "no live reload, always needs a
// restart" shape.

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

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: () => {}, off: () => {} }),
}))

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const getIni = vi.spyOn(serverFilesApi, 'getIni')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function sandboxDataInRange() {
  return {
    VERSION: 1,
    settings: {},
    ZombieLore: {},
    ZombieConfig: { ZombiesCountBeforeDelete: 100 },
    MultiplierConfig: {},
    Map: {},
    Basement: {},
  }
}

function mockCommonLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
}

describe('ServerConfig.tsx: Sandbox tab Save controls must not claim a reload that never happens', () => {
  it('toolbar Save button on the Sandbox tab reads plain "Save", not "Save & reload"', async () => {
    mockCommonLoads()
    getPaths.mockResolvedValue({
      exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
    } as never)
    getSandbox.mockResolvedValue({ sandbox: sandboxDataInRange() } as never)

    render(
      <MemoryRouter initialEntries={['/server-config?tab=sandbox']}>
        <ServerConfig />
      </MemoryRouter>,
    )

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())

    // Exact match: this must find the Sandbox toolbar's Save button and must
    // NOT match "Save & reload" text (which would also satisfy a looser
    // /save/i query, hiding the bug).
    expect(await screen.findByRole('button', { name: /^save$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save & reload/i })).not.toBeInTheDocument()
  })

  it('sticky unsaved-changes bar on the Sandbox tab also reads plain "Save" once an edit is made', async () => {
    mockCommonLoads()
    getPaths.mockResolvedValue({
      exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
    } as never)
    getSandbox.mockResolvedValue({ sandbox: sandboxDataInRange() } as never)

    render(
      <MemoryRouter initialEntries={['/server-config?tab=sandbox&search=ZombiesCountBeforeDelete']}>
        <ServerConfig />
      </MemoryRouter>,
    )

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())

    const input = await screen.findByDisplayValue('100')
    fireEvent.change(input, { target: { value: '200' } })

    // The sticky bar only mounts once hasSandboxChanges is true.
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())

    const saveButtons = screen.getAllByRole('button', { name: /^save$/i })
    expect(saveButtons.length).toBeGreaterThanOrEqual(2) // toolbar + sticky bar
    expect(screen.queryByRole('button', { name: /save & reload/i })).not.toBeInTheDocument()
  })

  it('contrast: the INI tab keeps its genuine "Save & reload" label (an RCON reload really is attempted there)', async () => {
    mockCommonLoads()
    getPaths.mockResolvedValue({
      exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
    } as never)
    getIni.mockResolvedValue({ settings: {}, duplicateKeys: [] } as never)

    render(
      <MemoryRouter initialEntries={['/server-config?tab=ini']}>
        <ServerConfig />
      </MemoryRouter>,
    )

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: /save & reload/i })).toBeInTheDocument()
  })
})
