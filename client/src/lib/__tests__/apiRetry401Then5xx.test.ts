import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../api'
import { clearAccessToken, setAccessToken } from '../authToken'

// fetchWithRetry's 401-refresh-then-retry and its own exponential-backoff
// retry are two separate mechanisms. Before this fix, a response that
// refreshed the token and retried, then got a TRANSIENT failure (5xx/429)
// on that retried request, was returned unconditionally -- skipping the
// backoff-retry loop entirely, unlike every other response in this
// function. So the unluckiest requests (an expired token AND a transient
// blip on the very next call) got the LEAST resilience, not the same as
// everything else. A bare 5xx (no 401 involved) already worked before this
// fix and would pass either way, so it proves nothing on its own -- these
// tests specifically exercise the 401-then-5xx sequence.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchWithRetry: 401-refresh-then-retry does not skip the backoff retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setAccessToken('expired-token')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearAccessToken()
  })

  it('retries a transient 5xx that arrives on the post-refresh retry, instead of returning it immediately', async () => {
    let targetCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-token' })
      }
      targetCallCount++
      if (targetCallCount === 1) return jsonResponse(401, { error: 'expired' })
      if (targetCallCount === 2) return jsonResponse(503, { error: 'temporarily unavailable' })
      return jsonResponse(200, { ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = apiFetch('/some/protected/endpoint')
    // Let the 401 -> refresh -> retry(503) chain settle, then advance past
    // the backoff delay so the retry loop's next iteration actually fires.
    await vi.advanceTimersByTimeAsync(3000)
    const response = await promise

    expect(response.status).toBe(200)
    // 401, then the 503 from the post-refresh retry, then the backoff
    // retry that finally reaches 200 -- three calls to the target
    // endpoint, not two. Two would mean the 503 was returned unfixed.
    expect(targetCallCount).toBe(3)
  })

  it('still returns a non-retryable status from the post-refresh retry immediately (unchanged behavior)', async () => {
    let targetCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-token' })
      }
      targetCallCount++
      if (targetCallCount === 1) return jsonResponse(401, { error: 'expired' })
      return jsonResponse(403, { error: 'forbidden' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = apiFetch('/some/protected/endpoint')
    await vi.advanceTimersByTimeAsync(3000)
    const response = await promise

    expect(response.status).toBe(403)
    // No backoff retry for a genuinely non-retryable status -- this proves
    // the fix didn't turn every post-refresh-retry response into a retry,
    // only the transient ones the normal (non-401) path already retries.
    expect(targetCallCount).toBe(2)
  })

  it('still force-reloads when the refreshed token itself still 401s (unchanged behavior)', async () => {
    // jsdom's window.location.reload is non-configurable, so it can't be
    // spied on directly (Object.defineProperty/vi.spyOn both throw) -- the
    // standard workaround is redefining the `location` property on
    // `window` itself, which jsdom DOES allow, with a stand-in object.
    const originalLocation = window.location
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })

    let targetCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-token' })
      }
      targetCallCount++
      return jsonResponse(401, { error: 'expired' })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const promise = apiFetch('/some/protected/endpoint')
      await vi.advanceTimersByTimeAsync(3000)
      const response = await promise

      expect(response.status).toBe(401)
      expect(targetCallCount).toBe(2)
      expect(reloadSpy).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })
})
