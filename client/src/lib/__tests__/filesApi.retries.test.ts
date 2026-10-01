import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesApi, waitForJob } from '../filesApi'
import type { JobResponse } from '@/types/files'

// What a Server Files read does when something fails on the way: a network
// drop, a proxy's 502 or the panel-wide 429 is sent again after a short
// wait; a timeout or an answer the file manager gave itself is not (over
// SFTP that would only repeat the same slow work). And the job poll behind
// a permanent delete or a Trash purge outlasts a short outage instead of
// reporting a job that is still running as failed.

const JOB_ID = 'f'.repeat(32)

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

type Answer = Response | Error | 'hang'

// Answers /api/files requests in turn (the last one repeats); anything else
// (client warnings) answers at once.
function scriptedFetch(answers: Answer[]) {
  let index = 0
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/api/files')) return Promise.resolve(jsonResponse(200, {}))
    const answer = answers[Math.min(index++, answers.length - 1)]
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer.clone())
  })
}

const filesSends = (mock: ReturnType<typeof scriptedFetch>) => mock.mock.calls.filter(([input]) => String(input).includes('/api/files')).length

async function settle<T>(promise: Promise<T>, totalMs: number) {
  let outcome: { ok: true; value: T } | { ok: false; code: string } | null = null
  promise.then(
    (value) => { outcome = { ok: true, value } },
    (error: { code?: string }) => { outcome = { ok: false, code: error?.code ?? String(error) } },
  )
  for (let elapsed = 0; elapsed < totalMs && outcome === null; elapsed += 250) await vi.advanceTimersByTimeAsync(250)
  return outcome
}

const listing = { entries: [], total: 0 }
const list = () => filesApi.list('p1', { root: 'data', path: 'Logs', offset: 0, limit: 500, sort: 'name', order: 'asc' })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a Server Files read', () => {
  it('is sent again after a proxy 502 and arrives', async () => {
    const fetchMock = scriptedFetch([jsonResponse(502, { error: 'Bad gateway' }), jsonResponse(200, listing)])
    vi.stubGlobal('fetch', fetchMock)
    expect(await settle(list(), 30_000)).toEqual({ ok: true, value: listing })
    expect(filesSends(fetchMock)).toBe(2)
  })

  it('is sent again after a network drop, and after the panel-wide 429 once its Retry-After has passed', async () => {
    const fetchMock = scriptedFetch([
      new TypeError('Failed to fetch'),
      jsonResponse(429, { error: 'Too many requests', code: 'RATE_LIMITED' }, { 'Retry-After': '3' }),
      jsonResponse(200, listing),
    ])
    vi.stubGlobal('fetch', fetchMock)
    const pending = list()
    await vi.advanceTimersByTimeAsync(1500)
    expect(filesSends(fetchMock)).toBe(2)
    // The 429 asked for 3 s, longer than the 2 s backoff.
    await vi.advanceTimersByTimeAsync(2000)
    expect(filesSends(fetchMock)).toBe(2)
    expect(await settle(pending, 30_000)).toEqual({ ok: true, value: listing })
    expect(filesSends(fetchMock)).toBe(3)
  })

  it('gives up after three retries', async () => {
    const fetchMock = scriptedFetch([jsonResponse(503, { error: 'Service unavailable' })])
    vi.stubGlobal('fetch', fetchMock)
    expect(await settle(list(), 60_000)).toEqual({ ok: false, code: 'HTTP_503' })
    expect(filesSends(fetchMock)).toBe(4)
  })

  it("isn't sent again for the file manager's own answer (an SFTP timeout) or its own limit", async () => {
    for (const [status, code] of [[504, 'FM_SFTP_TIMEOUT'], [502, 'FM_SFTP_ERROR'], [429, 'FM_RATE_LIMITED']] as const) {
      const fetchMock = scriptedFetch([jsonResponse(status, { error: 'x', code }), jsonResponse(200, listing)])
      vi.stubGlobal('fetch', fetchMock)
      expect(await settle(list(), 30_000)).toEqual({ ok: false, code })
      expect(filesSends(fetchMock)).toBe(1)
    }
  })

  it("isn't sent again after it timed out", async () => {
    const fetchMock = scriptedFetch(['hang', jsonResponse(200, listing)])
    vi.stubGlobal('fetch', fetchMock)
    expect(await settle(list(), 120_000)).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(filesSends(fetchMock)).toBe(1)
  })
})

describe('waitForJob', () => {
  const job = (state: JobResponse['state'], done: number) => ({ id: JOB_ID, kind: 'permanentDelete', state, progress: { done, total: 3 } })

  it('keeps polling through a proxy 502 and a timed-out poll, and ends with the job', async () => {
    const fetchMock = scriptedFetch([
      jsonResponse(200, job('running', 1)),
      // One poll: a 502 and its three retries all fail on the way.
      jsonResponse(502, { error: 'Bad gateway' }),
      jsonResponse(502, { error: 'Bad gateway' }),
      jsonResponse(502, { error: 'Bad gateway' }),
      jsonResponse(502, { error: 'Bad gateway' }),
      'hang',
      jsonResponse(200, job('done', 3)),
    ])
    vi.stubGlobal('fetch', fetchMock)
    const seen: string[] = []
    const outcome = await settle(waitForJob(JOB_ID, (j) => seen.push(j.state)), 300_000)
    expect(outcome).toMatchObject({ ok: true, value: { state: 'done' } })
    expect(seen).toEqual(['running', 'done'])
  })

  it('ends at once on an answer, such as a job the server no longer knows', async () => {
    const fetchMock = scriptedFetch([jsonResponse(404, { error: 'gone', code: 'FM_JOB_NOT_FOUND' }), jsonResponse(200, job('done', 3))])
    vi.stubGlobal('fetch', fetchMock)
    expect(await settle(waitForJob(JOB_ID, () => {}), 30_000)).toEqual({ ok: false, code: 'FM_JOB_NOT_FOUND' })
    expect(filesSends(fetchMock)).toBe(1)
  })

  it('gives up when the panel stays unreachable', async () => {
    const fetchMock = scriptedFetch([new TypeError('Failed to fetch')])
    vi.stubGlobal('fetch', fetchMock)
    expect(await settle(waitForJob(JOB_ID, () => {}), 600_000)).toEqual({ ok: false, code: 'NETWORK_ERROR' })
  })
})
