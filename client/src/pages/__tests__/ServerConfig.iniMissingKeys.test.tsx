import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverApi, serverFilesApi, serversApi } from '@/lib/api'

// GH#182 follow-up. The form filled every schema key a file lacked with the
// schema default and resent the whole object, and PUT /ini appends any new
// non-empty key -- so one unrelated save from the form wrote PingFrequency,
// SteamPort1/2, PhysicsDelay and eight more Build 41 keys into every B42
// .ini, plus the panel's (sometimes wrong) default for any other missing
// key. Now a defaulted key is only sent once the operator changes it, and a
// Build 41-only key is shown only when the file already has it.

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
const saveIni = vi.spyOn(serverFilesApi, 'saveIni')
const saveAndReload = vi.spyOn(serverFilesApi, 'saveAndReload')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

function mockLoads(settings: Record<string, string>) {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  getIni.mockResolvedValue({ settings, path: '/a', serverName: 'servera' } as never)
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

async function clickSave() {
  const [button] = screen.getAllByRole('button', { name: /^save & reload$/i })
  expect(button).not.toBeDisabled()
  await act(async () => { fireEvent.click(button) })
}

describe('ServerConfig.tsx INI tab: keys the file does not have', () => {
  it('a form save sends only the file\'s own keys plus the edit -- no Build 41 keys, no injected defaults', async () => {
    mockLoads({ PublicName: 'Mine', PVP: 'true' })
    renderIniTab('PublicName')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    fireEvent.change(await screen.findByDisplayValue('Mine'), { target: { value: 'Other' } })
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ PublicName: 'Other', PVP: 'true' })
  })

  it('a key the file lacks is sent once the operator sets it (ShowCoordinates, new in 42.21)', async () => {
    mockLoads({ PublicName: 'Mine' })
    renderIniTab('ShowCoordinates')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    const toggle = await screen.findByRole('switch', { name: 'Show Coordinates' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ PublicName: 'Mine', ShowCoordinates: 'true' })
  })

  it('shows the 42.21 defaults for a missing key: Public and Enable Safehouses are off', async () => {
    mockLoads({ PublicName: 'Mine' })
    renderIniTab('Safehouse')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByRole('switch', { name: 'Enable Safehouses' })).toHaveAttribute('aria-checked', 'false')
    cleanup()

    renderIniTab('Public')
    expect(await screen.findByRole('switch', { name: 'Public Server' })).toHaveAttribute('aria-checked', 'false')
  })

  it('a Build 41-only key is hidden when the file lacks it', async () => {
    mockLoads({ PublicName: 'Mine' })
    renderIniTab('Ping')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText('Ping Limit')).toBeInTheDocument()
    expect(screen.queryByText('Ping Frequency')).not.toBeInTheDocument()
    expect(screen.queryByText('Build 41 only')).not.toBeInTheDocument()
  })

  it('a Build 41-only key the file has is shown, badged, and saved unchanged', async () => {
    mockLoads({ PublicName: 'Mine', PingFrequency: '15' })
    renderIniTab('PingFrequency')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText('Ping Frequency')).toBeInTheDocument()
    expect(screen.getByText('Build 41 only')).toBeInTheDocument()
    fireEvent.change(await screen.findByDisplayValue('15'), { target: { value: '20' } })
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ PublicName: 'Mine', PingFrequency: '20' })
  })

  it('SteamScoreboard=admin (B41) shows Off -- what B42 falls back to -- and says the value is not recognized', async () => {
    mockLoads({ SteamScoreboard: 'admin' })
    renderIniTab('SteamScoreboard')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByRole('switch', { name: 'Steam Scoreboard' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/set to admin, which this panel does not recognize/i)).toBeInTheDocument()
  })

  it('a boolean written as 1 reads as on, as BooleanConfigOption parses it', async () => {
    mockLoads({ SteamScoreboard: '1' })
    renderIniTab('SteamScoreboard')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByRole('switch', { name: 'Steam Scoreboard' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/does not recognize/i)).not.toBeInTheDocument()
  })
})
