import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { forgetServerRunningAcks } from '@/lib/filesApi'
import { FakeFilesServer, FakeXhr, json, makeEntry, makeListing, renderFiles, stubLayout } from './filesTestHarness'

// Spec §A14.3 Upload: one batch preflight, ONE "replace these?" prompt for
// the whole batch, folders dropped keep their sub folders (created with
// X-File-Mkdirs), a running upload can be cancelled, and a 429 pauses the
// queue until Retry-After instead of failing the rest of the batch.

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

type PreflightFile = { relPath: string; ok: boolean; willReplace: boolean; currentEtag?: string; code?: string }

function preflightWith(decide: (relPath: string) => Partial<PreflightFile>, required: string[] = []) {
  server.on(({ method, path, body }) => {
    if (method !== 'POST' || !path.endsWith('/upload/preflight')) return undefined
    return json(200, {
      files: body.files.map((file: { relPath: string }) => ({ relPath: file.relPath, ok: true, willReplace: false, ...decide(file.relPath) })),
      required,
    })
  })
}

function pick(input: HTMLElement, files: File[]) {
  fireEvent.change(input, { target: { files } })
}

beforeEach(() => {
  forgetServerRunningAcks()
  server = new FakeFilesServer()
  server.install()
  FakeXhr.install()
  restoreLayout = stubLayout()
  server.listings.set('data|', makeListing([makeEntry('a.txt')]))
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Files: uploading a batch', () => {
  it('asks once about existing files; Skip existing uploads only the new ones', async () => {
    preflightWith((relPath) => (relPath === 'a.txt' ? { willReplace: true, currentEtag: 's:1-1' } : {}), ['overwrite'])
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['1'], 'a.txt'), new File(['2'], 'b.txt')])

    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText('1 file already exists in Zomboid folder')).toBeInTheDocument()
    expect(within(prompt).getByText(enFiles.upload.existsBody)).toBeInTheDocument()
    expect(within(prompt).getByRole('button', { name: enFiles.upload.replaceAll })).toBeInTheDocument()
    expect(within(prompt).getByRole('button', { name: enFiles.actions.cancel })).toBeInTheDocument()
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.upload.skipExisting }))

    expect(await screen.findByText(enFiles.upload.allDone)).toBeInTheDocument()
    expect(FakeXhr.requests).toHaveLength(1)
    expect(FakeXhr.requests[0].headers['X-File-Name']).toBe('b.txt')
    expect(FakeXhr.requests[0].headers['X-File-Overwrite-Etag']).toBeUndefined()
    expect(FakeXhr.requests[0].headers['X-File-Confirm']).toBeUndefined()
    expect(server.callsTo('POST', '/upload/preflight')[0].body).toEqual({
      root: 'data',
      dir: '',
      files: [{ relPath: 'a.txt', size: 1 }, { relPath: 'b.txt', size: 1 }],
      confirm: [],
    })
    expect(screen.getByText(enFiles.upload.skipped)).toBeInTheDocument()
    // The folder is listed again once the queue drains.
    await waitFor(() => expect(server.callsTo('GET', '/list').length).toBeGreaterThan(1))
  })

  it('Replace all sends the etag the preflight saw and the overwrite token, with no second prompt', async () => {
    preflightWith((relPath) => (relPath === 'a.txt' ? { willReplace: true, currentEtag: 's:1-1' } : {}), ['overwrite'])
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['1'], 'a.txt'), new File(['2'], 'b.txt')])

    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.upload.replaceAll }))
    expect(await screen.findByText(enFiles.upload.allDone)).toBeInTheDocument()
    expect(FakeXhr.requests).toHaveLength(2)
    const replaced = FakeXhr.requests.find((request) => request.headers['X-File-Name'] === 'a.txt')!
    expect(replaced.headers['X-File-Overwrite-Etag']).toBe('s:1-1')
    expect(replaced.headers['X-File-Confirm']).toBe('overwrite')
  })

  it('Cancel on the prompt uploads nothing', async () => {
    preflightWith(() => ({ willReplace: true, currentEtag: 's:1-1' }), ['overwrite'])
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['1'], 'a.txt')])
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.actions.cancel }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(FakeXhr.requests).toHaveLength(0)
  })

  it('an executable upload asks with the executable sentence first', async () => {
    preflightWith(() => ({}), ['executable'])
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['#!/bin/sh'], 'start-server.sh')])
    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText('start-server.sh runs as code when the server starts. Only upload files you trust.')).toBeInTheDocument()
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.confirm.continue }))
    expect(await screen.findByText(enFiles.upload.allDone)).toBeInTheDocument()
    expect(FakeXhr.requests[0].headers['X-File-Confirm']).toBe('executable')
  })

  it('a file the preflight refuses is listed as failed with its reason', async () => {
    preflightWith((relPath) => (relPath === 'panelbridge.lua' ? { ok: false, code: 'FM_PATH_PROTECTED' } : {}))
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['x'], 'panelbridge.lua'), new File(['y'], 'ok.txt')])
    expect(await screen.findByText(enFiles.upload.allDone)).toBeInTheDocument()
    expect(FakeXhr.requests.map((request) => request.headers['X-File-Name'])).toEqual(['ok.txt'])
    expect(screen.getByText(/can't be changed here/)).toBeInTheDocument()
  })

  it('refuses more than 1000 files at once before asking the server', async () => {
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), Array.from({ length: 1001 }, (_, i) => new File(['x'], `f${i}.txt`)))
    expect(await screen.findByText('Upload at most 1000 files at once.')).toBeInTheDocument()
    expect(server.callsTo('POST', '/upload/preflight')).toHaveLength(0)
  })
})

describe('Files: Replace by upload', () => {
  it('from a search result, uploads into the folder of the file it replaces', async () => {
    const bin = makeEntry('Server/map.bin', 'file')
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    server.on(({ method, path }) =>
      method === 'GET' && path.endsWith('/search') ? json(200, { results: [bin], truncated: false, scanned: 3 }) : undefined)
    preflightWith(() => ({ willReplace: true, currentEtag: 's:1234-7' }))
    renderFiles('/files?server=p1&root=data&path=')
    const filter = await screen.findByPlaceholderText(enFiles.list.filterPlaceholder)
    fireEvent.change(filter, { target: { value: 'map' } })
    fireEvent.submit(filter.closest('form')!)
    // A search result names its folder too; open it with the row's name button.
    const rows = await screen.findAllByRole('button', { name: /map\.bin/ })
    fireEvent.click(rows.find((button) => button.hasAttribute('data-row-primary'))!)
    fireEvent.click(await screen.findByRole('button', { name: enFiles.actions.replaceByUpload }))
    pick(screen.getByTestId('files-replace-input'), [new File(['x'], 'whatever.bin')])

    await waitFor(() => expect(server.callsTo('POST', '/upload/preflight')).toHaveLength(1))
    expect(server.callsTo('POST', '/upload/preflight')[0].body).toMatchObject({ dir: 'Server', files: [{ relPath: 'map.bin', size: 1 }] })
    await waitFor(() => expect(FakeXhr.requests).toHaveLength(1))
    expect(FakeXhr.requests[0].headers['X-File-Dir']).toBe('Server')
    expect(FakeXhr.requests[0].headers['X-File-Name']).toBe('map.bin')
    expect(FakeXhr.requests[0].headers['X-File-Overwrite-Etag']).toBe('s:1234-7')
  })
})

describe('Files: dropping a folder', () => {
  function fileEntry(name: string, content: string) {
    return { isFile: true, isDirectory: false, name, file: (ok: (file: File) => void) => ok(new File([content], name)) }
  }
  function dirEntry(name: string, children: unknown[]) {
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let done = false
        return {
          // Like the real API: batches until an empty one.
          readEntries: (ok: (entries: unknown[]) => void) => {
            const batch = done ? [] : children
            done = true
            ok(batch)
          },
        }
      },
    }
  }

  it('keeps the folder structure and creates missing folders', async () => {
    preflightWith(() => ({}))
    renderFiles()
    const table = await screen.findByRole('table')
    const dropped = dirEntry('mymod', [fileEntry('mod.info', 'name=x'), dirEntry('media', [fileEntry('init.lua', '--')])])
    fireEvent.drop(table, {
      dataTransfer: {
        types: ['Files'],
        items: [{ kind: 'file', webkitGetAsEntry: () => dropped }],
        files: [],
      },
    })

    expect(await screen.findByText(enFiles.upload.allDone)).toBeInTheDocument()
    expect(server.callsTo('POST', '/upload/preflight')[0].body.files).toEqual([
      { relPath: 'mymod/mod.info', size: 6 },
      { relPath: 'mymod/media/init.lua', size: 2 },
    ])
    const sent = FakeXhr.requests.map((request) => [request.headers['X-File-Dir'], request.headers['X-File-Name'], request.headers['X-File-Mkdirs']])
    expect(sent).toEqual([
      ['mymod', 'mod.info', '1'],
      ['mymod%2Fmedia', 'init.lua', '1'],
    ])
  })
})

describe('Files: the upload queue', () => {
  it('cancels an upload in flight', async () => {
    preflightWith(() => ({}))
    FakeXhr.respond = () => {}
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['1'], 'big.zip')])

    fireEvent.click(await screen.findByRole('button', { name: `${enFiles.actions.cancel}: big.zip` }))
    expect(await screen.findByText(enFiles.upload.cancelled)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${enFiles.actions.retry}: big.zip` })).toBeInTheDocument()
  })

  it('pauses on 429 and resumes after Retry-After', async () => {
    preflightWith(() => ({}))
    let attempts = 0
    FakeXhr.respond = (request) => {
      attempts += 1
      if (attempts === 1) request.xhr.finish(429, { error: 'Too many', code: 'FM_RATE_LIMITED' }, { 'Retry-After': '1' })
      else request.xhr.finish(201, { entry: makeEntry('b.txt'), sha256: 'abc', replaced: null })
    }
    renderFiles()
    await screen.findByRole('button', { name: 'a.txt' })
    pick(screen.getByTestId('files-upload-input'), [new File(['1'], 'b.txt')])

    expect(await screen.findByText(/Paused by the rate limit, resuming in \d s/)).toBeInTheDocument()
    expect(await screen.findByText(enFiles.upload.done, {}, { timeout: 10000 })).toBeInTheDocument()
    expect(FakeXhr.requests).toHaveLength(2)
    expect(screen.getByText(enFiles.upload.allDone)).toBeInTheDocument()
  })
})
