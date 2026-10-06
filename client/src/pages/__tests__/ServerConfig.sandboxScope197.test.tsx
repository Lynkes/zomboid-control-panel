import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// #197: GET /server-files/sandbox used to flatten a mod table's keys into
// `settings`, and this page sent its whole sandbox object back on every save,
// so a nested "Explosives = 1.0" was written over a top-level
// "Explosives = { ... }" table. The server now reports every table as its own
// section and adds `parseError` when SandboxVars.lua does not parse.

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
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const saveSandbox = vi.spyOn(serverFilesApi, 'saveSandbox')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

const emptySections = {
  VERSION: 6,
  settings: {},
  ZombieLore: {},
  ZombieConfig: {},
  MultiplierConfig: {},
  Map: {},
  Basement: {},
  Music: {},
  Debug: {},
}

function mockLoads(body: Record<string, unknown>) {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
  getPaths.mockResolvedValue({
    exists: { ini: false, sandbox: true, spawnpoints: false, spawnregions: false },
  } as never)
  getSandbox.mockResolvedValue(body as never)
  saveSandbox.mockResolvedValue({ success: true, created: false, message: 'saved', path: '/x' } as never)
}

function renderSandboxTab() {
  return render(
    <MemoryRouter initialEntries={['/server-config?tab=sandbox']}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: SandboxVars.lua that does not parse', () => {
  it("shows the parser's message and where to fix it", async () => {
    const message = "line 2720: '}' expected (to close '{' at line 1) near 'VanillaBallisticsEnabled'"
    mockLoads({ sandbox: emptySections, parseError: { message, line: 2720, column: 9 } })
    renderSandboxTab()

    expect(await screen.findByText("SandboxVars.lua has a Lua error, so this form can't show it")).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByText(/run the repair under Checks & Fixes/)).toBeInTheDocument()
  })

  it('shows no banner for a file that parses', async () => {
    mockLoads({ sandbox: emptySections })
    renderSandboxTab()

    await waitFor(() => expect(getSandbox).toHaveBeenCalled())
    expect(screen.queryByText(/has a Lua error/)).not.toBeInTheDocument()
  })
})

describe('ServerConfig.tsx: mod tables are their own sections', () => {
  it('lists each Explosives under its own table and saves an edit back under that table', async () => {
    mockLoads({
      sandbox: {
        ...emptySections,
        LootTweaks: { Explosives: 1 },
        Explosives: { VanillaBallisticsEnabled: false },
      },
    })
    renderSandboxTab()

    fireEvent.click(await screen.findByRole('button', { name: /Additional Settings/ }))
    const lootGroup = (await screen.findByRole('heading', { name: 'LootTweaks' })).parentElement!.parentElement!
    const modGroup = screen.getByRole('heading', { name: 'Explosives' }).parentElement!.parentElement!
    expect(within(lootGroup).getByDisplayValue('1')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Main section' })).not.toBeInTheDocument()

    fireEvent.change(within(modGroup).getByDisplayValue('false'), { target: { value: 'true' } })
    const [save] = screen.getAllByRole('button', { name: /^save$/i })
    await act(async () => { fireEvent.click(save) })

    await waitFor(() => expect(saveSandbox).toHaveBeenCalledTimes(1))
    const sent = saveSandbox.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(sent.settings).toEqual({})
    expect(sent.LootTweaks).toEqual({ Explosives: 1 })
    expect(sent.Explosives).toEqual({ VanillaBallisticsEnabled: true })
  })
})
