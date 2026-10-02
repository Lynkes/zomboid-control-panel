import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverApi, serverFilesApi, serversApi } from '@/lib/api'
import { ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY } from '@/lib/serverConfigSchema'

// GH#182 (p3x1187): "VoiceMaxDistance ... Form says a max value of 1000 ...
// If I set the setting to 40000 in raw and enable 'allow values outside
// known ranges' I still get the red banner saying I can't save."
//
// Three separate faults behind that one report:
//   1. INI_SCHEMA capped VoiceMaxDistance at 1000; the game takes 0-100000
//      (covered by iniSchemaBoundsGroundTruth.test.ts).
//   2. The range override in Settings only ever applied to the Sandbox tab;
//      invalidIniSettings ignored it.
//   3. invalidIniSettings is computed from the STRUCTURED iniSettings state
//      but gated Save in raw mode too -- the INI twin of the Sandbox raw-mode
//      lockout fixed in 547c625a. A raw save of an out-of-range value
//      reloads into the structured state and then disables Save in BOTH
//      modes, raw included, with no way back out from either editor.

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
const getStatus = vi.spyOn(serverApi, 'getStatus')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const saveRaw = vi.spyOn(serverFilesApi, 'saveRaw')
const saveIni = vi.spyOn(serverFilesApi, 'saveIni')
const saveAndReload = vi.spyOn(serverFilesApi, 'saveAndReload')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

// SpeedLimit is 10-150 in the real game (and now in INI_SCHEMA); 200 was the
// panel's old max, a value the game itself drops on load.
function mockLoads(settings: Record<string, string>, raw = '') {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  getIni.mockResolvedValue({ settings, path: '/a', serverName: 'servera' } as never)
  getRaw.mockResolvedValue({ content: raw, path: '/a', filename: 'servera.ini' } as never)
  saveRaw.mockResolvedValue({ success: true } as never)
  saveIni.mockResolvedValue({ success: true } as never)
  saveAndReload.mockResolvedValue({ success: true } as never)
}

function renderIniTab(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/server-config?tab=ini${search ? `&search=${search}` : ''}`]}>
      <ServerConfig />
    </MemoryRouter>,
  )
}

const saveButtons = () => screen.getAllByRole('button', { name: /^save & reload$/i })

describe('ServerConfig.tsx INI tab: GH#182 range handling', () => {
  it('the reported value (VoiceMaxDistance=40000) is valid now, with the override off', async () => {
    mockLoads({ VoiceMaxDistance: '40000' })
    renderIniTab('VoiceMaxDistance')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByDisplayValue('40000')).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText(/fix invalid values before saving/i)).not.toBeInTheDocument()
  })

  it('override OFF: an out-of-range value still blocks Save in the form editor', async () => {
    mockLoads({ SpeedLimit: '200' })
    renderIniTab('SpeedLimit')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(/fix invalid values before saving/i)).toBeInTheDocument()
    expect(screen.queryByText(/will still be saved/i)).not.toBeInTheDocument()

    fireEvent.change(await screen.findByDisplayValue('200'), { target: { value: '201' } })
    for (const button of saveButtons()) expect(button).toBeDisabled()
  })

  it('override ON: the same value is a warning, not a block, and Save goes through', async () => {
    localStorage.setItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, 'true')
    mockLoads({ SpeedLimit: '200' })
    renderIniTab('SpeedLimit')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(/will still be saved/i)).toBeInTheDocument()
    expect(screen.queryByText(/fix invalid values before saving/i)).not.toBeInTheDocument()

    const input = await screen.findByDisplayValue('200')
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: '250' } })

    const buttons = saveButtons()
    for (const button of buttons) expect(button).not.toBeDisabled()
    await act(async () => { fireEvent.click(buttons[0]) })
    await waitFor(() => expect(saveIni).toHaveBeenCalledWith(expect.objectContaining({ SpeedLimit: '250' })))
  })

  it('override ON: a malformed value still blocks Save -- the toggle only widens the range check', async () => {
    localStorage.setItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, 'true')
    mockLoads({ SpeedLimit: 'fast' })
    renderIniTab('SpeedLimit')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(/fix invalid values before saving/i)).toBeInTheDocument()
  })

  it('a select value the schema no longer offers (BadWordPolicy=4, rejected by B42) is shown, not blanked', async () => {
    mockLoads({ BadWordPolicy: '4' })
    renderIniTab('BadWordPolicy')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(/set to 4, which this panel does not recognize/i)).toBeInTheDocument()
  })

  it('raw mode is not locked by an out-of-range value in the loaded form state', async () => {
    mockLoads({ SpeedLimit: '200' }, 'SpeedLimit=200\n')
    renderIniTab()

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(/fix invalid values before saving/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^raw$/i }))
    await waitFor(() => expect(getRaw).toHaveBeenCalledWith('ini'))
    const textarea = await screen.findByDisplayValue(/SpeedLimit=200/)
    fireEvent.change(textarea, { target: { value: 'SpeedLimit=120\n' } })

    // The form-state banner does not describe the raw file and must not
    // block it.
    expect(screen.queryByText(/fix invalid values before saving/i)).not.toBeInTheDocument()
    const buttons = saveButtons()
    for (const button of buttons) expect(button).not.toBeDisabled()
    await act(async () => { fireEvent.click(buttons[0]) })
    await waitFor(() => expect(saveRaw).toHaveBeenCalledWith('ini', 'SpeedLimit=120\n'))
  })
})
