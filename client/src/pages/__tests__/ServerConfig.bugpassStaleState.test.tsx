import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { panelBridgeApi, serverApi, serverFilesApi, serversApi } from '@/lib/api'

// Bug pass before the UX release, Server Configuration:
// - the raw editor kept the previous server's file after an active-server
//   switch (and after Refresh), so a save wrote server A's text over B's file;
// - Mod Settings kept listing the previous server's options after a switch;
// - the Sandbox Save sent the whole form, which put back a Mod Settings edit
//   (PUT /sandbox-option) made earlier in the same visit;
// - opening the page on itself (sidebar entry, palette section) changed ?tab=
//   and dropped unsaved raw edits without asking;
// - unsaved Spawn Regions list edits didn't count as form edits for the Raw
//   button.

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
const getStatus = vi.spyOn(serverApi, 'getStatus')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const saveSandbox = vi.spyOn(serverFilesApi, 'saveSandbox')
const getSpawnRegions = vi.spyOn(serverFilesApi, 'getSpawnRegions')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
  localStorage.clear()
})

const serverA = { id: 1, name: 'Server A', serverName: 'servera', isRemote: false }
const serverB = { id: 2, name: 'Server B', serverName: 'serverb', isRemote: false }

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

function mockServer(server: typeof serverA, opts: { sandbox?: Record<string, unknown> } = {}) {
  getResolvedActive.mockResolvedValue({ server: server as never })
  getActive.mockResolvedValue({ server: { id: server.id, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: !!opts.sandbox, spawnpoints: false, spawnregions: true },
  } as never)
  getIni.mockResolvedValue({ settings: { SpeedLimit: '70' }, path: '/a', serverName: server.serverName } as never)
  if (opts.sandbox) getSandbox.mockResolvedValue({ sandbox: opts.sandbox } as never)
  getSpawnRegions.mockResolvedValue({ spawnregions: [{ name: 'Muldraugh, KY', file: 'media/maps/Muldraugh, KY/spawnpoints.lua' }] } as never)
  getRaw.mockImplementation(async (type) => ({
    content: `${server.serverName} ${type} file`,
    path: '/a',
    filename: `${server.serverName}.${type}`,
  }) as never)
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ConfirmProvider>
        <TooltipProvider>
        <Routes>
          <Route
            path="/server-config"
            element={(
              <>
                <Link to="/server-config">Server Configuration (sidebar)</Link>
                <ServerConfig />
              </>
            )}
          />
        </Routes>
        </TooltipProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

describe('ServerConfig.tsx: the raw editor follows a reload', () => {
  it('shows the new active server\'s file after a switch, not the previous one\'s', async () => {
    mockServer(serverA)
    renderAt('/server-config?tab=ini')
    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(1))

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Raw' })) })
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('servera ini file'))

    mockServer(serverB)
    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(getIni).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('serverb ini file'))
  })
})

describe('ServerConfig.tsx: Mod Settings after an active-server switch', () => {
  it('asks the new server\'s bridge instead of keeping the previous server\'s options', async () => {
    mockServer(serverA)
    sendCommand.mockResolvedValue({
      success: true,
      data: { options: { ModOfServerA: [{ name: 'ModOfServerA.Speed', shortName: 'Speed', value: 1, type: 'integer' }] }, groups: [{ name: 'ModOfServerA', count: 1 }], totalCount: 1, enumerated: true },
    } as never)
    renderAt('/server-config?tab=modsettings')
    expect(await screen.findByRole('button', { name: /Mod Of Server A/ })).toBeInTheDocument()
    expect(sendCommand).toHaveBeenCalledTimes(1)

    mockServer(serverB)
    sendCommand.mockResolvedValue({
      success: true,
      data: { options: { ModOfServerB: [{ name: 'ModOfServerB.Size', shortName: 'Size', value: 2, type: 'integer' }] }, groups: [{ name: 'ModOfServerB', count: 1 }], totalCount: 1, enumerated: true },
    } as never)
    act(() => { emitActiveServerChanged() })

    expect(await screen.findByRole('button', { name: /Mod Of Server B/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mod Of Server A/ })).not.toBeInTheDocument()
    expect(sendCommand).toHaveBeenCalledTimes(2)
  })
})

describe('ServerConfig.tsx: the Sandbox Save sends only what the form changed', () => {
  it('leaves values the form did not change out of PUT /sandbox (a Mod Settings edit on disk stays)', async () => {
    mockServer(serverA, {
      sandbox: {
        ...emptySections,
        LootTweaks: { Explosives: 1 },
        Explosives: { VanillaBallisticsEnabled: false },
      },
    })
    saveSandbox.mockResolvedValue({ success: true, created: false, message: 'saved', path: '/x' } as never)
    renderAt('/server-config?tab=sandbox')

    fireEvent.click(await screen.findByRole('button', { name: /Additional Settings/ }))
    const modGroup = (await screen.findByRole('heading', { name: 'Explosives' })).parentElement!.parentElement!
    fireEvent.change(modGroup.querySelector('select, input') as HTMLElement, { target: { value: 'true' } })
    const [save] = screen.getAllByRole('button', { name: /^save$/i })
    await act(async () => { fireEvent.click(save) })

    await waitFor(() => expect(saveSandbox).toHaveBeenCalledTimes(1))
    const sent = saveSandbox.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(sent).toEqual({ Explosives: { VanillaBallisticsEnabled: true } })
  })

  it('still sends the whole form when SandboxVars.lua does not exist yet (the save creates it)', async () => {
    mockServer(serverA)
    saveSandbox.mockResolvedValue({ success: true, created: true, message: 'created', path: '/x' } as never)
    renderAt('/server-config?tab=sandbox')
    await waitFor(() => expect(getPaths).toHaveBeenCalled())

    // The page fills the form from the schema defaults; any edit makes it dirty.
    const numberInput = (await screen.findAllByRole('textbox')).find((el) => (el as HTMLInputElement).inputMode === 'decimal') as HTMLInputElement
    fireEvent.change(numberInput, { target: { value: String(Number(numberInput.value || '0') + 1) } })
    const [save] = screen.getAllByRole('button', { name: /^save$/i })
    await act(async () => { fireEvent.click(save) })

    await waitFor(() => expect(saveSandbox).toHaveBeenCalledTimes(1))
    const sent = saveSandbox.mock.calls[0][0] as unknown as Record<string, Record<string, unknown>>
    expect(Object.keys(sent.settings ?? {}).length + Object.keys(sent.ZombieLore ?? {}).length).toBeGreaterThan(1)
  })
})

describe('ServerConfig.tsx: opening the page on itself with unsaved raw edits', () => {
  it('asks before the sidebar entry changes the tab, and stays with the edits when cancelled', async () => {
    mockServer(serverA, { sandbox: emptySections })
    renderAt('/server-config?tab=sandbox')
    await waitFor(() => expect(getSandbox).toHaveBeenCalled())

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Raw' })) })
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('servera sandbox file'))
    await act(async () => { fireEvent.change(textarea, { target: { value: 'edited sandbox' } }) })

    fireEvent.click(screen.getByRole('link', { name: 'Server Configuration (sidebar)' }))
    expect(await screen.findByText('Discard your unsaved raw edits?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.getByRole('tab', { name: /sandbox/i, hidden: true })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('textbox')).toHaveValue('edited sandbox')
    expect(getRaw).toHaveBeenCalledTimes(1)
  })
})

describe('ServerConfig.tsx: Spawn Regions list edits and the Raw button', () => {
  it('asks before opening the raw file over unsaved list edits', async () => {
    mockServer(serverA)
    renderAt('/server-config?tab=spawnregions')
    await waitFor(() => expect(getSpawnRegions).toHaveBeenCalled())

    fireEvent.change(await screen.findByRole('textbox', { name: 'Region 1 display name' }), { target: { value: 'Muldraugh renamed' } })

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(await screen.findByText('Open the raw editor without your form changes?')).toBeInTheDocument()
    expect(getRaw).not.toHaveBeenCalled()
  })
})
