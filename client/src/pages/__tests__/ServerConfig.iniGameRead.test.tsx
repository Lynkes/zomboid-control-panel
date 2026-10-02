import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverApi, serverFilesApi, serversApi } from '@/lib/api'

// GH#182 follow-up. parseIni() trims every server.ini value, so the form
// showed "Public= true" as On while PZ 42.21 rejects " true" and keeps the
// default. GET /ini now also returns rawSettings (each value as the game
// reads it) and misnamedKeys (lines the game skips, e.g. "PVP = true"); the
// form edits and resends the raw values, so an untouched line stays
// byte-for-byte on the server.

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

const NBSP = String.fromCharCode(0xa0)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

// GET /ini as the server builds it: `settings` trimmed, `rawSettings` not.
function mockLoads(rawSettings: Record<string, string>, misnamedKeys: Record<string, string> = {}) {
  const settings = Object.fromEntries(Object.entries(rawSettings).map(([key, value]) => [key, value.trim()]))
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  getIni.mockResolvedValue({ settings, rawSettings, misnamedKeys, path: '/a', serverName: 'servera' } as never)
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

describe('ServerConfig.tsx INI tab: values as the game reads them', () => {
  it('"Public= true" shows Off, the default the game keeps, and names the stray space', async () => {
    mockLoads({ Public: ' true' })
    renderIniTab('Public')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByRole('switch', { name: 'Public Server' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(
      'This server is currently set to ␣true, which the game does not accept, so it uses Off (its default) until you change it.',
    )).toBeInTheDocument()
  })

  it('an unrelated save sends every untouched value exactly as loaded, spaces included', async () => {
    mockLoads({ PublicName: 'Mine', Public: ' true', MaxPlayers: ' 16' })
    renderIniTab('PublicName')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    fireEvent.change(await screen.findByDisplayValue('Mine'), { target: { value: 'Other' } })
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ PublicName: 'Other', Public: ' true', MaxPlayers: ' 16' })
  })

  it('switching Public on sends "true", which the server writes as Public=true', async () => {
    mockLoads({ Public: ' true' })
    renderIniTab('Public')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('switch', { name: 'Public Server' }))
    expect(screen.queryByText(/the game does not accept/)).not.toBeInTheDocument()
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ Public: 'true' })
  })

  it('"MaxPlayers= 16" is a valid number: the game\'s Double.parseDouble trims the space itself', async () => {
    mockLoads({ MaxPlayers: ' 16' })
    renderIniTab('MaxPlayers')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByDisplayValue('16')).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('Fix invalid values before saving')).not.toBeInTheDocument()
  })

  it('a no-break space next to a number is an error the row explains, because the game keeps its default', async () => {
    mockLoads({ PingLimit: `${NBSP}400` })
    renderIniTab('PingLimit')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(
      'The game can\'t read [U+00A0]400 as a number, so it uses its default. Retype the number without the space.',
    )).toBeInTheDocument()
    expect(screen.getByText('Fix invalid values before saving')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('400'), { target: { value: '400' } })
    expect(screen.queryByText(/can't read/)).not.toBeInTheDocument()
    expect(screen.queryByText('Fix invalid values before saving')).not.toBeInTheDocument()
  })

  it('a select the game reads as a number shows " 2" as option 2', async () => {
    mockLoads({ BadWordPolicy: ' 2' })
    renderIniTab('BadWordPolicy')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText('Bad Word Policy')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveTextContent('Kick')
    expect(screen.queryByText(/does not recognize/)).not.toBeInTheDocument()
  })

  it('a text value with "=" in it says where the game stops reading', async () => {
    mockLoads({ PublicName: 'Rules: PvP = off' })
    renderIniTab('PublicName')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByText(
      'The game reads this value only up to the first "=", so it uses: Rules: PvP',
    )).toBeInTheDocument()
  })
})

describe('ServerConfig.tsx INI tab: lines the game skips (misnamedKeys)', () => {
  it('"PVP = false" shows the default the game uses, On, and says why', async () => {
    mockLoads({ PVP: ' false' }, { PVP: 'PVP ' })
    renderIniTab('PVP')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    expect(await screen.findByRole('switch', { name: 'Enable PvP' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(
      'The game ignores this line in the file: it reads the setting name as PVP␣, so it uses the default shown here. Changing this setting rewrites the line so the game reads it.',
    )).toBeInTheDocument()
    expect(screen.queryByText(/does not accept/)).not.toBeInTheDocument()
  })

  it('an unrelated save leaves that line out, so the server keeps it as written', async () => {
    mockLoads({ PublicName: 'Mine', PVP: ' false' }, { PVP: 'PVP ' })
    renderIniTab('PublicName')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    fireEvent.change(await screen.findByDisplayValue('Mine'), { target: { value: 'Other' } })
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ PublicName: 'Other' })
  })

  it('changing the setting sends it, and the warning goes once the save lands', async () => {
    mockLoads({ PVP: ' false' }, { PVP: 'PVP ' })
    renderIniTab('PVP')

    await waitFor(() => expect(getIni).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable PvP' }))
    getIni.mockResolvedValue({
      settings: { PVP: 'false' },
      rawSettings: { PVP: 'false' },
      misnamedKeys: {},
      path: '/a',
      serverName: 'servera',
    } as never)
    await clickSave()

    await waitFor(() => expect(saveIni).toHaveBeenCalledTimes(1))
    expect(saveIni).toHaveBeenCalledWith({ PVP: 'false' })
    await waitFor(() => expect(screen.queryByText(/ignores this line/)).not.toBeInTheDocument())
    expect(screen.getByRole('switch', { name: 'Enable PvP' })).toHaveAttribute('aria-checked', 'false')
  })
})
