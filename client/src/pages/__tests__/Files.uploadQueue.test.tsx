import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import enFiles from '@/locales/en/files.json'
import { forgetServerRunningAcks } from '@/lib/filesApi'
import Files from '../Files'
import { FakeFilesServer, FakeXhr, json, makeEntry, makeListing, makeProfile, makeRoot, renderFiles, stubLayout, type XhrRequest } from './filesTestHarness'

// The upload queue around the page: leaving Files mid-upload, two batches
// whose "Replace these?" prompts overlap, "Try again" after the server's
// state changed since the batch was checked, and files dropped where the
// page doesn't take them.

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
  FakeXhr.install()
  restoreLayout = stubLayout()
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const allOk = ({ method, path, body }: { method: string; path: string; body: { files: Array<{ relPath: string }> } }) =>
  method === 'POST' && path.endsWith('/upload/preflight')
    ? json(200, { files: body.files.map((file) => ({ relPath: file.relPath, ok: true, willReplace: false })), required: [] })
    : undefined

describe('Files: leaving the page mid-upload', () => {
  it('does not abort the files in flight and then send the rest to nobody', async () => {
    server.listings.set('data|', makeListing([makeEntry('a.txt')]))
    server.on(allOk)
    // The first two stay in flight; the rest would be answered at once.
    FakeXhr.respond = (request) => {
      const name = request.headers['X-File-Name']
      if (name === '1.lua' || name === '2.lua') return
      request.xhr.finish(201, { entry: makeEntry(name), sha256: 'abc', replaced: null })
    }
    const aborted: string[] = []
    const originalAbort = FakeXhr.prototype.abort
    FakeXhr.prototype.abort = function abort(this: FakeXhr) {
      const request = FakeXhr.requests.find((candidate) => candidate.xhr === this)
      if (request) aborted.push(request.headers['X-File-Name'])
      return originalAbort.call(this)
    }
    try {
      render(
        <MemoryRouter initialEntries={['/files?server=p1&root=data']}>
          <SocketContext.Provider value={null as never}>
            <TooltipProvider>
              <ConfirmProvider>
                <Routes>
                  <Route path="/files" element={<Files />} />
                  <Route path="/other" element={<div>other page</div>} />
                </Routes>
                <Link to="/other">go elsewhere</Link>
                <Toaster />
              </ConfirmProvider>
            </TooltipProvider>
          </SocketContext.Provider>
        </MemoryRouter>,
      )
      await screen.findByRole('button', { name: 'a.txt' })
      const files = [1, 2, 3, 4, 5].map((n) => {
        const file = new File([`-- ${n}`], `${n}.lua`)
        Object.defineProperty(file, 'webkitRelativePath', { value: `MyMod/${n}.lua` })
        return file
      })
      fireEvent.change(screen.getByTestId('files-upload-folder-input'), { target: { files } })
      await waitFor(() => expect(FakeXhr.requests.length).toBeGreaterThanOrEqual(2))
      const sentBefore = FakeXhr.requests.length

      fireEvent.click(screen.getByText('go elsewhere'))
      await screen.findByText('other page')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      const sentAfter = FakeXhr.requests.length - sentBefore
      // Either the queue survives (nothing aborted) or it stops (nothing more sent).
      expect(aborted.length > 0 && sentAfter > 0).toBe(false)
    } finally {
      FakeXhr.prototype.abort = originalAbort
    }
  })
})

describe('Files: two "Replace these?" prompts at once', () => {
  it('the second batch waits its turn instead of being dropped', async () => {
    server.listings.set('data|', makeListing([makeEntry('a.txt'), makeEntry('c.txt')]))
    let releaseFirst: (() => void) | null = null
    let calls = 0
    server.on(({ method, path, body }) => {
      if (method !== 'POST' || !path.endsWith('/upload/preflight')) return undefined
      calls += 1
      const response = json(200, {
        files: body.files.map((file: { relPath: string }) => ({ relPath: file.relPath, ok: true, willReplace: true, currentEtag: 's:1-1' })),
        required: ['overwrite'],
      })
      if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = () => resolve(response) })
      return response
    })
    FakeXhr.respond = (request) => request.xhr.finish(201, { entry: makeEntry(request.headers['X-File-Name']), sha256: 'abc', replaced: { trashId: 't' } })
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    fireEvent.change(screen.getByTestId('files-upload-input'), { target: { files: [new File(['1'], 'a.txt')] } })
    await waitFor(() => expect(releaseFirst).not.toBeNull())
    fireEvent.change(screen.getByTestId('files-upload-input'), { target: { files: [new File(['2'], 'c.txt')] } })
    expect(within(await screen.findByRole('alertdialog')).getByText('c.txt')).toBeInTheDocument()

    await act(async () => {
      releaseFirst!()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Still the first prompt that came up; answer it.
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: enFiles.upload.replaceAll }))
    // Then the other batch's prompt.
    await waitFor(() => expect(within(screen.getByRole('alertdialog')).getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: enFiles.upload.replaceAll }))
    await waitFor(() => expect(FakeXhr.requests.map((request) => request.headers['X-File-Name']).sort()).toEqual(['a.txt', 'c.txt']))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('Files: "Try again" after the state changed since the batch was checked', () => {
  // The first pre-check ran while the server was stopped and b.txt didn't
  // exist; every later one sees the server as it is now.
  function preflightThen(later: Record<string, unknown>) {
    let calls = 0
    server.on(({ method, path, body }) => {
      if (method !== 'POST' || !path.endsWith('/upload/preflight')) return undefined
      calls += 1
      if (calls === 1) return allOk({ method, path, body })
      return json(200, { files: body.files.map((file: { relPath: string }) => ({ relPath: file.relPath, ok: true, ...(later.file as object) })), required: later.required, details: later.details })
    })
  }

  async function uploadAndFail() {
    server.listings.set('data|', makeListing([makeEntry('a.txt')]))
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    fireEvent.change(screen.getByTestId('files-upload-input'), { target: { files: [new File(['x'], 'b.txt')] } })
    await screen.findByText(new RegExp(enFiles.upload.failed))
    return screen.getByRole('button', { name: `${enFiles.actions.retry}: b.txt` })
  }

  async function continueIfAsked() {
    const prompt = await screen.findByRole('alertdialog')
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.confirm.continue }))
  }

  it('the server started: it asks, then sends serverRunning', async () => {
    preflightThen({ file: { willReplace: false }, required: ['serverRunning'], details: { serverState: 'running' } })
    FakeXhr.respond = (request: XhrRequest) => {
      const tokens = (request.headers['X-File-Confirm'] ?? '').split(',')
      if (!tokens.includes('serverRunning')) {
        request.xhr.finish(409, { error: 'x', code: 'FM_CONFIRMATION_REQUIRED', params: { required: ['serverRunning'] }, details: { serverState: 'running' } })
      } else {
        request.xhr.finish(201, { entry: makeEntry('b.txt'), sha256: 'abc', replaced: null })
      }
    }
    fireEvent.click(await uploadAndFail())
    await continueIfAsked()
    await waitFor(() => expect(FakeXhr.requests).toHaveLength(2))
    expect(FakeXhr.requests[1].headers['X-File-Confirm']).toBe('serverRunning')
    expect(await screen.findByText(enFiles.upload.done)).toBeInTheDocument()
  })

  it('the file appeared: it asks to replace it and sends the new version\'s etag', async () => {
    preflightThen({ file: { willReplace: true, currentEtag: 's:9-9' }, required: ['overwrite'], details: { overwrite: { names: ['b.txt'] } } })
    FakeXhr.respond = (request: XhrRequest) => {
      if (!request.headers['X-File-Overwrite-Etag']) request.xhr.finish(409, { error: 'x', code: 'FM_EXISTS', params: { name: 'b.txt' } })
      else request.xhr.finish(201, { entry: makeEntry('b.txt'), sha256: 'abc', replaced: { trashId: 't' } })
    }
    fireEvent.click(await uploadAndFail())
    await continueIfAsked()
    await waitFor(() => expect(FakeXhr.requests).toHaveLength(2))
    expect(FakeXhr.requests[1].headers['X-File-Overwrite-Etag']).toBe('s:9-9')
    expect(FakeXhr.requests[1].headers['X-File-Confirm']).toBe('overwrite')
  })
})

describe('Files: files dropped where the page does not take them', () => {
  beforeEach(() => {
    server.profiles = [makeProfile({ roots: [makeRoot('data', { trashItemCount: 1 }), makeRoot('install', { writable: false, readOnlyReason: 'permissions' })] })]
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    server.listings.set('install|', makeListing([makeEntry('media', 'dir')]))
    server.on(({ method, path }) => (method === 'GET' && path.endsWith('/trash') ? json(200, { items: [], totalBytes: 0 }) : undefined))
  })

  const fileDrag = () => ({ dataTransfer: { types: ['Files'], files: [], items: [], dropEffect: 'none' } })
  // fireEvent returns false when the event was cancelled: the browser's own
  // "open the dropped file in this tab" does not run.
  const browserOpensIt = (target: Element) => ({
    dragover: fireEvent.dragOver(target, fileDrag()),
    drop: fireEvent.drop(target, fileDrag()),
  })

  it('the header and the left column cancel the drop', async () => {
    renderFiles()
    await screen.findByRole('button', { name: 'Server' })
    expect(browserOpensIt(screen.getByRole('heading', { name: enFiles.page.title }))).toEqual({ dragover: false, drop: false })
    expect(browserOpensIt(screen.getByRole('button', { name: /^Trash/ }))).toEqual({ dragover: false, drop: false })
  })

  it('the list while Trash is open cancels the drop', async () => {
    renderFiles()
    fireEvent.click(await screen.findByRole('button', { name: /^Trash/ }))
    expect(browserOpensIt(await screen.findByText(enFiles.trash.description))).toEqual({ dragover: false, drop: false })
  })

  it('the list of a read-only root cancels the drop and uploads nothing', async () => {
    renderFiles('/files?server=p1&root=install&path=')
    expect(browserOpensIt(await screen.findByRole('button', { name: 'media' }))).toEqual({ dragover: false, drop: false })
    expect(server.callsTo('POST', '/upload/preflight')).toHaveLength(0)
  })
})
