import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import enFiles from '@/locales/en/files.json'
import enShell from '@/locales/en/shell.json'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'
import { forgetServerRunningAcks } from '@/lib/filesApi'
import Files from '../Files'
import {
  FakeFilesServer,
  LocationProbe,
  currentParams,
  json,
  makeEntry,
  makeListing,
  makeProfile,
  makeRoot,
  makeText,
  renderFiles,
  stubLayout,
} from './filesTestHarness'

// UX restructure, slice B (Files): the folder's Trash is a place in the URL
// (?view=trash) opened from the header, the selection's actions live on the
// selection bar only, the server's own settings files offer the Server
// Configuration form, and an editor with unsaved text asks before a link
// leaves the page.

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

const TRASH_ITEM = {
  trashId: '20260928T100000Z-aaaaaaaa',
  originalPath: 'Server/old.ini',
  type: 'file',
  bytes: 10,
  files: 1,
  deletedAt: '2026-09-28T10:00:00.000Z',
  deletedBy: { username: 'kate' },
  reason: 'deleted',
  expiresAt: '2026-10-05T10:00:00.000Z',
}

beforeEach(() => {
  forgetServerRunningAcks()
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  server.profiles = [makeProfile({ roots: [makeRoot('data', { trashItemCount: 1 }), makeRoot('install')] })]
  server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('console.txt')]))
  server.on(({ method, path }) => (method === 'GET' && path.endsWith('/trash') ? json(200, { items: [TRASH_ITEM], totalBytes: 10 }) : undefined))
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Files: Trash is a place in the URL', () => {
  it('the header link opens Trash with ?view=trash, and going back to the folder clears it', async () => {
    renderFiles()
    const header = (await screen.findByRole('heading', { level: 1, name: enFiles.page.title })).closest('section') as HTMLElement
    const link = await within(header).findByRole('link', { name: 'Trash (1 item)' })
    expect(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('view')).toBe('trash')

    fireEvent.click(link)
    expect(await screen.findByText('Server/old.ini')).toBeInTheDocument()
    expect(currentParams(screen.getByTestId).get('view')).toBe('trash')
    expect(currentParams(screen.getByTestId).get('root')).toBe('data')
    expect(within(header).getByRole('link', { name: 'Trash (1 item)' })).toHaveAttribute('aria-current', 'page')

    // The way back names the folder the Trash belongs to.
    fireEvent.click(screen.getByRole('button', { name: enFiles.roots.labels.data }))
    await screen.findByRole('button', { name: 'console.txt' })
    expect(currentParams(screen.getByTestId).get('view')).toBeNull()
  })

  it('a reload (or a link) with ?view=trash opens the Trash directly', async () => {
    renderFiles('/files?server=p1&root=data&path=&view=trash')
    expect(await screen.findByText('Server/old.ini')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'console.txt' })).not.toBeInTheDocument()
    // The rail marks Trash, not the folder, as where you are.
    expect(screen.getByRole('button', { name: 'Trash (1 item)' })).toHaveAttribute('aria-current', 'true')
  })

  it('has its own Refresh, now that the header has none', async () => {
    renderFiles('/files?server=p1&root=data&path=&view=trash')
    await screen.findByText('Server/old.ini')
    const header = screen.getByRole('heading', { level: 1, name: enFiles.page.title }).closest('section') as HTMLElement
    expect(within(header).queryByRole('button', { name: enFiles.page.refresh })).not.toBeInTheDocument()
    const before = server.callsTo('GET', '/trash').length
    fireEvent.click(screen.getByRole('button', { name: enFiles.page.refresh }))
    await waitFor(() => expect(server.callsTo('GET', '/trash').length).toBeGreaterThan(before))
  })
})

describe('Files on a phone: one folder chooser', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: !query.includes('min-width: 768px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }))
    Element.prototype.scrollIntoView = vi.fn()
    server.profiles = [makeProfile({
      roots: [makeRoot('data', { trashItemCount: 1 }), makeRoot('install')],
      bookmarks: [{ rootId: 'data', path: 'Server', kind: 'serverSettings' }],
    })]
    server.listings.set('data|Server', makeListing([makeEntry('Server/servertest.ini')]))
  })

  it('the Select holds the folders, the shortcuts and Trash; nothing repeats them under the list', async () => {
    renderFiles()
    await screen.findByRole('button', { name: /^console.txt/ })
    // The old phone layout listed the shortcuts and Trash again below the files.
    expect(screen.queryByText(enFiles.roots.bookmarks.heading)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trash (1 item)' })).not.toBeInTheDocument()

    const chooser = screen.getByRole('combobox', { name: enFiles.roots.heading })
    fireEvent.keyDown(chooser, { key: 'Enter' })
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: enFiles.roots.labels.install })).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: enFiles.roots.bookmarks.serverSettings })).toBeInTheDocument()
    fireEvent.keyDown(within(listbox).getByRole('option', { name: 'Trash (1 item)' }), { key: 'Enter' })

    expect(await screen.findByText('Server/old.ini')).toBeInTheDocument()
    expect(currentParams(screen.getByTestId).get('view')).toBe('trash')
  })

  it('a shortcut from the Select opens its folder', async () => {
    renderFiles()
    await screen.findByRole('button', { name: /^console.txt/ })
    fireEvent.keyDown(screen.getByRole('combobox', { name: enFiles.roots.heading }), { key: 'Enter' })
    const listbox = await screen.findByRole('listbox')
    fireEvent.keyDown(within(listbox).getByRole('option', { name: enFiles.roots.bookmarks.serverSettings }), { key: 'Enter' })
    expect(await screen.findByRole('button', { name: /^servertest\.ini/ })).toBeInTheDocument()
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
  })
})

describe('Files: one home for each selection action', () => {
  it('Download as .zip and Delete show once, on the selection bar', async () => {
    renderFiles()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select console.txt' }))
    const bar = await screen.findByRole('region', { name: '1 selected' })
    expect(screen.getAllByRole('button', { name: enFiles.actions.downloadZip })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: enFiles.actions.delete })).toHaveLength(1)
    expect(within(bar).getByRole('button', { name: enFiles.actions.downloadZip })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: enFiles.actions.delete })).toBeInTheDocument()
  })
})

const INI = makeEntry('Server/servertest.ini')
const SANDBOX = makeEntry('Server/servertest_SandboxVars.lua')
const OTHER = makeEntry('Server/notes.txt')

function withSettingsFiles() {
  server.listings.set('data|Server', makeListing([INI, SANDBOX, OTHER]))
  server.texts.set('data|Server/servertest.ini', makeText(INI, 'PVP=true\n', { hints: ['panelRewritesKeys'] }))
  server.texts.set('data|Server/servertest_SandboxVars.lua', makeText(SANDBOX, 'SandboxVars = {}\n'))
  server.texts.set('data|Server/notes.txt', makeText(OTHER, 'hello\n'))
}

async function openEditor(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }))
  const textarea = await screen.findByRole('textbox', { name })
  await waitFor(() => expect((textarea as HTMLTextAreaElement).value).not.toBe(''))
  return textarea
}

describe('Files editor: the same file as a form', () => {
  beforeEach(withSettingsFiles)

  it.each([
    ['servertest.ini', '/server-config?tab=ini'],
    ['servertest_SandboxVars.lua', '/server-config?tab=sandbox'],
  ])('%s links to its Server Configuration tab', async (name, href) => {
    renderFiles('/files?server=p1&root=data&path=Server')
    await openEditor(name)
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: enFiles.editor.editWithForm })).toHaveAttribute('href', href)
  })

  it('offers nothing for another file, or for a server that is not the active one', async () => {
    renderFiles('/files?server=p1&root=data&path=Server')
    await openEditor('notes.txt')
    expect(screen.queryByRole('link', { name: enFiles.editor.editWithForm })).not.toBeInTheDocument()
    cleanup()

    // Server Configuration edits the active server, not this one.
    server.profiles = [makeProfile({ isActive: false })]
    renderFiles('/files?server=p1&root=data&path=Server')
    await openEditor('servertest.ini')
    expect(screen.queryByRole('link', { name: enFiles.editor.editWithForm })).not.toBeInTheDocument()
  })
})

function renderGuarded(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SocketContext.Provider value={null as never}>
        <TooltipProvider>
          <ConfirmProvider>
            <UnsavedChangesProvider>
              {/* Leaving unmounts the page, as in the app. */}
              <Routes>
                <Route path="/files" element={<Files />} />
                <Route path="*" element={null} />
              </Routes>
              <LocationProbe />
              <Toaster />
            </UnsavedChangesProvider>
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

describe('Files editor: unsaved text and leaving the page', () => {
  beforeEach(withSettingsFiles)

  it('asks before a link leaves the page while the editor holds unsaved text', async () => {
    renderGuarded('/files?server=p1&root=data&path=Server')
    const textarea = await openEditor('servertest.ini')
    fireEvent.change(textarea, { target: { value: 'PVP=false\n' } })

    fireEvent.click(screen.getByRole('link', { name: enFiles.editor.editWithForm }))
    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText(enShell.unsavedChanges.title)).toBeInTheDocument()
    expect(screen.getByTestId('location').textContent).toMatch(/^\/files\?/)

    fireEvent.click(within(prompt).getByRole('button', { name: enShell.unsavedChanges.stay }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'servertest.ini' })).toHaveValue('PVP=false\n')
    expect(screen.getByTestId('location').textContent).toMatch(/^\/files\?/)

    fireEvent.click(screen.getByRole('link', { name: enFiles.editor.editWithForm }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enShell.unsavedChanges.leave }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/server-config?tab=ini'))
  })

  it('leaves without asking when nothing was changed', async () => {
    renderGuarded('/files?server=p1&root=data&path=Server')
    await openEditor('servertest.ini')
    fireEvent.click(screen.getByRole('link', { name: enFiles.editor.editWithForm }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/server-config?tab=ini'))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
