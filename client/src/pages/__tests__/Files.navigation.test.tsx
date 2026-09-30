import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import {
  FakeFilesServer,
  currentParams,
  makeEntry,
  makeListing,
  makeText,
  renderFiles,
  stubLayout,
} from './filesTestHarness'

// Spec §A14.1/§A14.2: where you are lives in the URL, the breadcrumb folds
// deep paths, the last folder per server and root is remembered (and the
// page still works when browser storage throws), and a deep link opens a
// file.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'kate', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'token',
    can: () => true,
  }),
}))

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function listCallPaths(): string[] {
  return server.callsTo('GET', '/list').map((call) => call.url.searchParams.get('path') ?? '')
}

describe('Files: breadcrumb', () => {
  it('folds the middle of a deep path into a menu, marks the current folder, and navigates', async () => {
    server.listings.set('data|a/b/c/d', makeListing([makeEntry('a/b/c/d/deep.txt')]))
    server.listings.set('data|a/b/c', makeListing([makeEntry('a/b/c/d', 'dir')]))
    server.listings.set('data|a', makeListing([makeEntry('a/b', 'dir')]))
    renderFiles('/files?server=p1&root=data&path=a/b/c/d')

    const nav = await screen.findByRole('navigation', { name: enFiles.list.breadcrumbLabel })
    await within(nav).findByText('d')
    expect(within(nav).getByText('d').closest('[aria-current="page"]')).not.toBeNull()
    expect(within(nav).getByRole('button', { name: 'Zomboid folder' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'c' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'a' })).not.toBeInTheDocument()
    const more = within(nav).getByRole('button', { name: enFiles.list.breadcrumbMore })

    fireEvent.click(within(nav).getByRole('button', { name: 'c' }))
    await waitFor(() => expect(currentParams(screen.getByTestId).get('path')).toBe('a/b/c'))
    expect(await screen.findByRole('button', { name: 'd' })).toBeInTheDocument()
    expect(more).toBeTruthy()
  })

  it('Backspace in the list goes up one folder', async () => {
    server.listings.set('data|Server', makeListing([makeEntry('Server/a.ini')]))
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    renderFiles('/files?server=p1&root=data&path=Server')

    const name = await screen.findByRole('button', { name: 'a.ini' })
    fireEvent.keyDown(name, { key: 'Backspace' })
    await waitFor(() => expect(currentParams(screen.getByTestId).get('path')).toBe(''))
    expect(await screen.findByRole('button', { name: 'Server' })).toBeInTheDocument()
  })
})

describe('Files: remembering the last folder', () => {
  it('opens the remembered folder and remembers the next one', async () => {
    localStorage.setItem('zcp-files-last:p1:data', 'Server')
    server.listings.set('data|Server', makeListing([makeEntry('Server/Sub', 'dir')]))
    server.listings.set('data|Server/Sub', makeListing([makeEntry('Server/Sub/x.txt')]))
    renderFiles('/files?server=p1&root=data')

    fireEvent.click(await screen.findByRole('button', { name: 'Sub' }))
    expect(await screen.findByRole('button', { name: 'x.txt' })).toBeInTheDocument()
    expect(listCallPaths()).toEqual(['Server', 'Server/Sub'])
    expect(localStorage.getItem('zcp-files-last:p1:data')).toBe('Server/Sub')
  })

  it('ignores a remembered path that fails the name rules', async () => {
    localStorage.setItem('zcp-files-last:p1:data', '../outside')
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    renderFiles('/files?server=p1&root=data')
    expect(await screen.findByRole('button', { name: 'Server' })).toBeInTheDocument()
    expect(listCallPaths()).toEqual([''])
  })

  it('still works when browser storage throws on every access', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    server.listings.set('data|Server', makeListing([makeEntry('Server/a.ini')]))
    renderFiles('/files?server=p1&root=data')

    fireEvent.click(await screen.findByRole('button', { name: 'Server' }))
    expect(await screen.findByRole('button', { name: 'a.ini' })).toBeInTheDocument()
  })
})

describe('Files: deep link', () => {
  it('open= opens the file, and closing it leaves the folder in the URL', async () => {
    const ini = makeEntry('Server/servertest.ini')
    server.listings.set('data|Server', makeListing([ini]))
    server.texts.set('data|Server/servertest.ini', makeText(ini, 'PVP=true\n'))
    renderFiles('/files?server=p1&root=data&path=Server&open=servertest.ini')

    const editor = await screen.findByRole('textbox', { name: 'servertest.ini' })
    expect(editor).toHaveValue('PVP=true\n')
    expect(server.callsTo('GET', '/stat')[0].url.searchParams.get('path')).toBe('Server/servertest.ini')
    expect(currentParams(screen.getByTestId).get('open')).toBe('servertest.ini')

    // The first Close is the editor's own; the dialog's corner X (hidden by
    // CSS in a browser) is the second.
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: enFiles.actions.close })[0])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(currentParams(screen.getByTestId).get('open')).toBeNull())
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
  })

  it('a bookmark jumps to its folder', async () => {
    server.profiles[0].bookmarks = [{ rootId: 'data', path: 'Server', kind: 'serverSettings' }]
    server.listings.set('data|', makeListing([]))
    server.listings.set('data|Server', makeListing([makeEntry('Server/a.ini')]))
    renderFiles('/files?server=p1&root=data')

    fireEvent.click(await screen.findByRole('button', { name: enFiles.roots.bookmarks.serverSettings }))
    expect(await screen.findByRole('button', { name: 'a.ini' })).toBeInTheDocument()
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
  })
})
