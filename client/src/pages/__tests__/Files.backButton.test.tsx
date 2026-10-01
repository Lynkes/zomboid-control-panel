import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import enFiles from '@/locales/en/files.json'
import { forgetServerRunningAcks } from '@/lib/filesApi'
import Files from '../Files'
import { FakeFilesServer, LocationProbe, currentParams, fmError, json, makeEntry, makeListing, makeText, renderFiles, stubLayout } from './filesTestHarness'

// The browser's Back button while something is open over the list: the
// editor with unsaved text (pressed twice, or while Save is asking), and the
// New file / New folder dialog.

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
  forgetServerRunningAcks()
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const back = () => act(async () => {
  fireEvent.click(screen.getByTestId('history-back'))
})

describe('Files: Back with unsaved text in the editor', () => {
  it('a second Back while "Discard?" is up keeps the page and the text', async () => {
    const ini = makeEntry('Server/servertest.ini')
    server.listings.set('data|Server', makeListing([ini]))
    server.texts.set('data|Server/servertest.ini', makeText(ini, 'PVP=true\n'))
    render(
      <MemoryRouter initialEntries={['/dashboard', '/files?server=p1&root=data&path=Server']} initialIndex={1}>
        <SocketContext.Provider value={null as never}>
          <TooltipProvider>
            <ConfirmProvider>
              <Routes>
                <Route path="/files" element={<Files />} />
                <Route path="/dashboard" element={<div>DASHBOARD</div>} />
              </Routes>
              <LocationProbe />
              <Toaster />
            </ConfirmProvider>
          </TooltipProvider>
        </SocketContext.Provider>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'servertest.ini' }))
    const textarea = await screen.findByRole('textbox', { name: 'servertest.ini' })
    await waitFor(() => expect(textarea).toHaveValue('PVP=true\n'))
    fireEvent.change(textarea, { target: { value: 'PVP=false\n' } })

    await back()
    await screen.findByRole('alertdialog')
    await back()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    // The prompt is modal, so the editor behind it is aria-hidden.
    const editor = screen.queryByRole('textbox', { name: 'servertest.ini', hidden: true }) as HTMLTextAreaElement | null
    expect(screen.getByTestId('location').textContent ?? '').toMatch(/^\/files/)
    expect(screen.queryByText('DASHBOARD')).toBeNull()
    expect(editor?.value).toBe('PVP=false\n')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('Back while Save is asking a question leaves Save working afterwards', async () => {
    const script = makeEntry('start-server.sh')
    server.listings.set('install|', makeListing([script]))
    server.texts.set('install|start-server.sh', makeText(script, 'echo hi\n'))
    server.on(({ method, path, body }) => {
      if (method === 'PUT' && path.endsWith('/text')) {
        if (!body.confirm?.includes('executable')) {
          return fmError(409, 'FM_CONFIRMATION_REQUIRED', { required: ['executable'] }, { details: { executable: { names: ['start-server.sh'] } } })
        }
        return json(200, { entry: script, etag: 'h:saved', previousVersion: null, restartRequired: false, hints: [] })
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=install&path=')
    fireEvent.click(await screen.findByRole('button', { name: 'start-server.sh' }))
    const textarea = await screen.findByRole('textbox', { name: 'start-server.sh' })
    await waitFor(() => expect(textarea).toHaveValue('echo hi\n'))
    fireEvent.change(textarea, { target: { value: 'echo changed\n' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: enFiles.actions.save }))
    expect(within(await screen.findByRole('alertdialog')).getByText(/runs as code/)).toBeInTheDocument()

    // Back (or Android's back gesture) while the save's question is open,
    // then "Cancel" to whatever is asked: the operator keeps editing.
    await back()
    for (let i = 0; i < 3; i++) {
      const prompt = screen.queryByRole('alertdialog')
      if (!prompt) break
      fireEvent.click(within(prompt).getByRole('button', { name: enFiles.actions.cancel }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      })
    }
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('textbox', { name: 'start-server.sh' })).toHaveValue('echo changed\n')

    const putsBefore = server.callsTo('PUT', '/text').length
    const saveButton = within(screen.getByRole('dialog')).getByRole('button', { name: enFiles.actions.save }) as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)
    await waitFor(() => expect(server.callsTo('PUT', '/text').length - putsBefore).toBe(1))
  })
})

describe('Files: Back while the New file / New folder dialog is open', () => {
  beforeEach(() => {
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('Logs', 'dir')]))
    server.listings.set('data|Server', makeListing([makeEntry('Server/servertest.ini')]))
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/mkdir')) return json(201, { entry: makeEntry(body.path ? `${body.path}/${body.name}` : body.name, 'dir') })
      if (method === 'PUT' && path.endsWith('/text')) {
        return json(201, { entry: makeEntry(body.path, 'file', { flags: { editable: false } as never }), etag: 'h:x', previousVersion: null, restartRequired: false, hints: [] })
      }
      return undefined
    })
  })

  async function openInServerThenBack(button: string) {
    renderFiles('/files?server=p1&root=data&path=')
    fireEvent.click(await screen.findByRole('button', { name: 'Server' }))
    await screen.findByRole('checkbox', { name: 'Select servertest.ini' })
    fireEvent.click(screen.getByRole('button', { name: button }))
    await screen.findByRole('dialog')
    await back()
    await waitFor(() => expect(currentParams(screen.getByTestId).get('path')).toBe(''))
  }

  it('New folder is created in the folder the dialog was opened in', async () => {
    await openInServerThenBack(enFiles.actions.newFolder)
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(enFiles.dialogs.newFolder.nameLabel), { target: { value: 'mods' } })
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.create }))
    await waitFor(() => expect(server.callsTo('POST', '/mkdir')).toHaveLength(1))
    expect(server.callsTo('POST', '/mkdir')[0].body.path).toBe('Server')
  })

  it('New file is created in the folder the dialog was opened in', async () => {
    await openInServerThenBack(enFiles.actions.newFile)
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(enFiles.dialogs.newFile.nameLabel), { target: { value: 'notes.txt' } })
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.create }))
    await waitFor(() => expect(server.callsTo('PUT', '/text')).toHaveLength(1))
    expect(server.callsTo('PUT', '/text')[0].body.path).toBe('Server/notes.txt')
  })
})
