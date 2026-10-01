import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesApi } from '../filesApi'

// The server's own SFTP budget: 10 s per connect (+5 s grace), 20 s per
// operation, remote roots probed in parallel. A request the server answers
// inside that budget must not be given up on (and sent again) by the page
// before then, nor reported as a timeout after it was saved.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// Only /api/files requests are slow; anything else (client warnings) answers at once.
function slowFetch(delayMs: number, body: unknown) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/api/files')) return Promise.resolve(jsonResponse({}))
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(body)), delayMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  })
}

const filesSends = (mock: ReturnType<typeof slowFetch>) => mock.mock.calls.filter(([input]) => String(input).includes('/api/files')).length

async function settle<T>(promise: Promise<T>, totalMs: number) {
  let outcome: { ok: true; value: T } | { ok: false; code: string } | null = null
  promise.then(
    (value) => { outcome = { ok: true, value } },
    (error: { code?: string }) => { outcome = { ok: false, code: error?.code ?? String(error) } },
  )
  for (let elapsed = 0; elapsed < totalMs && outcome === null; elapsed += 500) await vi.advanceTimersByTimeAsync(500)
  return outcome
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('filesApi timeouts vs the server SFTP budget', () => {
  it('a profile answered at 20 s arrives, sent once', async () => {
    const fetchMock = slowFetch(20_000, { profile: { id: 'p1' } })
    vi.stubGlobal('fetch', fetchMock)
    const outcome = await settle(filesApi.getProfile('p1'), 120_000)
    expect(outcome).toEqual({ ok: true, value: { profile: { id: 'p1' } } })
    expect(filesSends(fetchMock)).toBe(1)
  })

  it('a listing answered at 18 s arrives, sent once', async () => {
    const fetchMock = slowFetch(18_000, { entries: [] })
    vi.stubGlobal('fetch', fetchMock)
    const outcome = await settle(filesApi.list('p1', { root: 'data', path: 'Saves/Multiplayer/servertest', offset: 0, limit: 500, sort: 'name', order: 'asc' }), 120_000)
    expect(outcome?.ok).toBe(true)
    expect(filesSends(fetchMock)).toBe(1)
  })

  it('saving the remote folders (saved, then probed) at 20 s is not a timeout', async () => {
    const fetchMock = slowFetch(20_000, { profile: { id: 'p1' } })
    vi.stubGlobal('fetch', fetchMock)
    const outcome = await settle(filesApi.setRemoteRoots('p1', { installPath: '/opt/pz', dataPath: null }), 120_000)
    expect(outcome).toEqual({ ok: true, value: { profile: { id: 'p1' } } })
  })

  it('a rename answered at 25 s is not a timeout', async () => {
    const fetchMock = slowFetch(25_000, { entry: { path: 'b.txt' } })
    vi.stubGlobal('fetch', fetchMock)
    const outcome = await settle(filesApi.rename('p1', { root: 'data', path: 'a.txt', newName: 'b.txt', confirm: [] }), 120_000)
    expect(outcome?.ok).toBe(true)
    expect(filesSends(fetchMock)).toBe(1)
  })
})
