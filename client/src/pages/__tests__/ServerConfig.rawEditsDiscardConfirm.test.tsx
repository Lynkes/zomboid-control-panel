import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { serverApi, serverFilesApi, serversApi } from '@/lib/api'

// Switching tab while the raw editor is open reloaded the textarea from disk
// (loadRawContent) without a word: unsaved raw edits were gone and the
// "unsaved changes" state with them. The Form and Raw buttons did the same
// for the edits made on the other side (Raw -> Form dropped the typed text;
// Form -> Raw opened the file as saved on disk, without the form's pending
// changes). Each now asks first, and only when there is something to lose.

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
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getRaw = vi.spyOn(serverFilesApi, 'getRaw')
const saveRaw = vi.spyOn(serverFilesApi, 'saveRaw')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mockLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  getIni.mockResolvedValue({ settings: { SpeedLimit: '70' }, path: '/a', serverName: 'servera' } as never)
  getRaw.mockResolvedValue({ content: 'SpeedLimit=70', path: '/a', filename: 'servera.ini' } as never)
}

async function renderIniTab() {
  mockLoads()
  render(
    <MemoryRouter initialEntries={['/server-config?tab=ini&search=SpeedLimit']}>
      <ConfirmProvider>
        <ServerConfig />
      </ConfirmProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(getIni).toHaveBeenCalled())
}

async function openRawAndEdit() {
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Raw' })) })
  await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(1))
  const textarea = await screen.findByRole('textbox')
  await waitFor(() => expect(textarea).toHaveValue('SpeedLimit=70'))
  await act(async () => { fireEvent.change(textarea, { target: { value: 'SpeedLimit=90' } }) })
  return textarea
}

function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

describe('ServerConfig.tsx: leaving the raw editor with unsaved edits asks first', () => {
  it('a tab change keeps the edits when cancelled and discards them when confirmed', async () => {
    await renderIniTab()
    const textarea = await openRawAndEdit()

    openTab(/sandbox/i)
    expect(await screen.findByText('Discard your unsaved raw edits?')).toBeInTheDocument()
    // Nothing was reloaded or switched yet.
    expect(getRaw).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tab', { name: /server settings/i, hidden: true })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Discard your unsaved raw edits?')).not.toBeInTheDocument())
    expect(textarea).toHaveValue('SpeedLimit=90')
    expect(getRaw).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tab', { name: /server settings/i, hidden: true })).toHaveAttribute('aria-selected', 'true')

    openTab(/sandbox/i)
    fireEvent.click(await screen.findByRole('button', { name: 'Discard edits' }))
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(2))
    // The tab is ?tab= now: the router applies it in a transition.
    await waitFor(() => expect(screen.getByRole('tab', { name: /sandbox/i, hidden: true })).toHaveAttribute('aria-selected', 'true'))
  })

  it('the Form button keeps the raw editor and its edits when cancelled', async () => {
    await renderIniTab()
    const textarea = await openRawAndEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Form' }))
    expect(await screen.findByText('Discard your unsaved raw edits?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Discard your unsaved raw edits?')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox')).toBe(textarea)
    expect(textarea).toHaveValue('SpeedLimit=90')

    fireEvent.click(screen.getByRole('button', { name: 'Form' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard edits' }))
    await waitFor(() => expect(textarea).not.toBeInTheDocument())
  })

  it('does not ask when the raw editor has no edits', async () => {
    await renderIniTab()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Raw' })) })
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('SpeedLimit=70'))

    openTab(/sandbox/i)
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Discard your unsaved raw edits?')).not.toBeInTheDocument()
  })
})

describe('ServerConfig.tsx: saved raw edits are not "unsaved" any more', () => {
  // The raw Spawn Points / Spawn Regions saves never moved the saved baseline,
  // so after a successful save every later tab change claimed unsaved edits.
  it('a tab change right after saving the raw Spawn Points file does not ask', async () => {
    await renderIniTab()
    openTab(/spawn points/i)
    saveRaw.mockResolvedValue({ success: true } as never)
    getRaw.mockResolvedValue({ content: 'spawn=1', path: '/a', filename: 'servera_spawnpoints.lua' } as never)

    fireEvent.click(await screen.findByRole('button', { name: 'Raw' }))
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(1))
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('spawn=1'))
    await act(async () => { fireEvent.change(textarea, { target: { value: 'spawn=2' } }) })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })) })
    await waitFor(() => expect(saveRaw).toHaveBeenCalledWith('spawnpoints', 'spawn=2'))

    openTab(/spawn regions/i)
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Discard your unsaved raw edits?')).not.toBeInTheDocument()
  })
})

describe('ServerConfig.tsx: opening the raw editor with unsaved form changes asks first', () => {
  it('stays in the form when cancelled and opens the file from disk when confirmed', async () => {
    await renderIniTab()
    fireEvent.change(await screen.findByDisplayValue('70'), { target: { value: '80' } })

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(await screen.findByText('Open the raw editor without your form changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Open the raw editor without your form changes?')).not.toBeInTheDocument())
    expect(getRaw).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('80')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }))
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(1))
  })

  it('does not ask when the form has no changes', async () => {
    await renderIniTab()
    await screen.findByDisplayValue('70')

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    await waitFor(() => expect(getRaw).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Open the raw editor without your form changes?')).not.toBeInTheDocument()
  })
})
