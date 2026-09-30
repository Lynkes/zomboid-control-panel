import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import { clearAccessToken, getAccessToken, setAccessToken } from '../authToken'
import {
  UPLOAD_ABORTED,
  downloadFile,
  downloadZip,
  filesApi,
  forgetServerRunningAcks,
  hasServerRunningAck,
  rememberServerRunningAck,
  uploadFile,
  withConfirmations,
} from '../filesApi'

// The Server Files client (spec §A10, §A14.3): tokens only ever travel in
// the Authorization header (never a URL), uploads replay once after an
// expired token like apiFetch does, a 429 surfaces its Retry-After, and the
// confirmation loop retries exactly once.

const TOKEN = 'secret-access-token-123'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

// ---- A minimal XMLHttpRequest stand-in ----

interface SentRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
  xhr: FakeXhr
}

const sent: SentRequest[] = []
let respond: (request: SentRequest) => void = () => {}

class FakeXhr {
  status = 0
  responseText = ''
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private method = ''
  private url = ''
  private headers: Record<string, string> = {}
  private responseHeaders: Record<string, string> = {}

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null
  }
  send(body: unknown) {
    const request = { method: this.method, url: this.url, headers: { ...this.headers }, body, xhr: this }
    sent.push(request)
    queueMicrotask(() => respond(request))
  }
  abort() {
    queueMicrotask(() => this.onabort?.())
  }
  // test helpers
  finish(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.responseHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 })
    this.onload?.()
  }
}

function uploadRequest() {
  return {
    profileId: 'p1',
    root: 'data' as const,
    dir: 'Server/sub dir',
    name: 'my file#1.ini',
    file: new Blob(['hello']),
    mkdirs: true,
    overwriteEtag: 's:5-1',
    confirm: ['overwrite' as const, 'serverRunning' as const],
  }
}

beforeEach(() => {
  sent.length = 0
  respond = () => {}
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  setAccessToken(TOKEN)
  forgetServerRunningAcks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearAccessToken()
})

describe('downloads never put a token in a URL', () => {
  it('downloadFile sends the bearer header and saves a blob named from Content-Disposition', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('abc', {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': "attachment; filename=\"a.ini\"; filename*=UTF-8''se%CC%81rver%20a.ini",
        'x-file-masked': '1',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn(() => 'blob:x')
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = vi.fn()
    const clicks: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download)
    })

    const result = await downloadFile('p1', { root: 'data', path: 'Server/a.ini' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('/api/files/profiles/p1/download?root=data&path=Server%2Fa.ini')
    expect(String(url)).not.toContain(TOKEN)
    expect(String(url)).not.toMatch(/token=/i)
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(result).toEqual({ fileName: 'sérver a.ini'.normalize('NFD'), masked: true })
    expect(clicks).toEqual(['sérver a.ini'.normalize('NFD')])
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it('downloadZip posts JSON with the bearer header, never a token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('PK', {
      status: 200,
      headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="s-data-Server-20260929-1200.zip"' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await downloadZip('p1', { root: 'data', paths: ['Server'] })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('/api/files/profiles/p1/zip')
    expect(String(url)).not.toContain(TOKEN)
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ root: 'data', paths: ['Server'] })
    click.mockRestore()
  })

  it('turns a JSON 413 before the zip stream into an ApiError with its code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(413, {
      error: 'This selection is too large to zip.',
      code: 'FM_ZIP_TOO_LARGE',
      params: { reason: 'entries', limit: 10000 },
    })))
    await expect(downloadZip('p1', { root: 'data', paths: ['Saves'] })).rejects.toMatchObject({ code: 'FM_ZIP_TOO_LARGE', status: 413 })
  })

  it('JSON routes put profile ids and paths in the query, and the token only in the header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { dir: {}, entries: [], total: 0, offset: 0, limit: 500, sortLimited: false, truncated: false, dirEtag: 'e' }))
    vi.stubGlobal('fetch', fetchMock)
    await filesApi.list('p 1', { root: 'data', path: 'Saves/Multiplayer', offset: 0, limit: 500, sort: 'name', order: 'asc' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('/api/files/profiles/p%201/list?root=data&path=Saves%2FMultiplayer&offset=0&limit=500&sort=name&order=asc')
    expect(String(url)).not.toContain(TOKEN)
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('mutations always send Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { entry: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await filesApi.mkdir('p1', { root: 'data', path: '', name: 'x', confirm: [] })
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect(new Headers((init as RequestInit).headers).get('Content-Type')).toBe('application/json')
  })
})

describe('uploadFile (XHR)', () => {
  it('sends the upload headers, the bearer token in the header only, and the raw body', async () => {
    respond = (request) => request.xhr.finish(201, { entry: { name: 'x' }, sha256: 'abc', replaced: null })
    const progress = vi.fn()
    const request = uploadRequest()
    const result = await uploadFile(request, progress).promise

    expect(result.sha256).toBe('abc')
    expect(sent).toHaveLength(1)
    const [first] = sent
    expect(first.method).toBe('POST')
    expect(first.url).toBe('/api/files/profiles/p1/upload')
    expect(first.url).not.toContain(TOKEN)
    expect(first.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'X-File-Root': 'data',
      'X-File-Dir': 'Server%2Fsub%20dir',
      'X-File-Name': 'my%20file%231.ini',
      'X-File-Mkdirs': '1',
      'X-File-Overwrite-Etag': 's:5-1',
      'X-File-Confirm': 'overwrite,serverRunning',
    })
    expect(first.body).toBe(request.file)
    expect(progress).toHaveBeenCalledWith(5, 5)
  })

  it('refreshes an expired token once and replays the upload', async () => {
    let calls = 0
    respond = (request) => {
      calls += 1
      if (calls === 1) request.xhr.finish(401, { error: 'expired', code: 'TOKEN_EXPIRED' })
      else request.xhr.finish(201, { entry: {}, sha256: 'def', replaced: null })
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { accessToken: 'fresh-token' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await uploadFile(uploadRequest(), () => {}).promise

    expect(result.sha256).toBe('def')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }))
    expect(sent).toHaveLength(2)
    expect(sent[1].headers.Authorization).toBe('Bearer fresh-token')
    expect(getAccessToken()).toBe('fresh-token')
  })

  it('rejects a 429 with the Retry-After seconds, without retrying on its own', async () => {
    respond = (request) => request.xhr.finish(429, { error: 'Too many', code: 'FM_RATE_LIMITED' }, { 'Retry-After': '7' })
    const error = await uploadFile(uploadRequest(), () => {}).promise.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, code: 'FM_RATE_LIMITED', retryAfterSeconds: 7 })
    expect(sent).toHaveLength(1)
  })

  it('abort() rejects with UPLOAD_ABORTED', async () => {
    respond = () => {}
    const handle = uploadFile(uploadRequest(), () => {})
    await Promise.resolve()
    handle.abort()
    await expect(handle.promise).rejects.toMatchObject({ code: UPLOAD_ABORTED })
  })
})

describe('withConfirmations', () => {
  function confirmationError(required: string[]) {
    return new ApiError('Confirm this change first.', {
      status: 409,
      code: 'FM_CONFIRMATION_REQUIRED',
      data: { error: 'Confirm this change first.', code: 'FM_CONFIRMATION_REQUIRED', params: { required }, details: { serverState: 'running' } },
    })
  }

  it('asks once and retries once with the tokens the server named', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(confirmationError(['serverRunning', 'executable']))
      .mockResolvedValueOnce('saved')
    const ask = vi.fn().mockResolvedValue(true)

    const result = await withConfirmations(run, ask, ['overwrite'])

    expect(result).toEqual({ ok: true, value: 'saved' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0].params.required).toEqual(['serverRunning', 'executable'])
    expect(run.mock.calls).toEqual([[['overwrite']], [['overwrite', 'serverRunning', 'executable']]])
  })

  it('a second FM_CONFIRMATION_REQUIRED is an error, not another prompt', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(confirmationError(['serverRunning']))
      .mockRejectedValueOnce(confirmationError(['executable']))
    const ask = vi.fn().mockResolvedValue(true)

    await expect(withConfirmations(run, ask)).rejects.toMatchObject({ code: 'FM_CONFIRMATION_REQUIRED' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('declining stops without a second request', async () => {
    const run = vi.fn().mockRejectedValueOnce(confirmationError(['permanent']))
    const ask = vi.fn().mockResolvedValue(false)
    await expect(withConfirmations(run, ask)).resolves.toEqual({ ok: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('passes any other error straight through', async () => {
    const run = vi.fn().mockRejectedValue(new ApiError('gone', { status: 404, code: 'FM_NOT_FOUND' }))
    const ask = vi.fn()
    await expect(withConfirmations(run, ask)).rejects.toMatchObject({ code: 'FM_NOT_FOUND' })
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('the serverRunning acknowledgement memory', () => {
  it('lasts 10 minutes per profile, in memory only', () => {
    const now = 1_000_000
    expect(hasServerRunningAck('p1', now)).toBe(false)
    rememberServerRunningAck('p1', now)
    expect(hasServerRunningAck('p1', now + 9 * 60_000)).toBe(true)
    expect(hasServerRunningAck('p2', now)).toBe(false)
    expect(hasServerRunningAck('p1', now + 10 * 60_000 + 1)).toBe(false)
  })
})
