import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, endServerSession, refreshSession, tryRefreshToken } from './api'
import { clearAccessToken, getAccessToken, setAccessToken } from './authToken'
import { createSocketAuthProvider } from './socketAuth'

// Auth audit 2026-10-08, client session items: one shared refresh path
// (#19), a token cleared only when the panel refuses the cookie (#20), no
// silent switch to another account (#15) and no session brought back by a
// refresh that lands after sign-out (#14).

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeToken(userId: string, expiresInSeconds = 15 * 60): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = { userId, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.sig`
}

function user(id: string) {
  return { id, username: id, role: 'admin', capabilities: null }
}

type Route = (init?: RequestInit) => Response | Promise<Response>

function stubFetch(routes: Record<string, Route | Route[]>) {
  const calls: Record<string, number> = {}
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [match, route] of Object.entries(routes)) {
      if (!url.includes(match)) continue
      const index = calls[match] ?? 0
      calls[match] = index + 1
      const respond = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route
      return respond(init)
    }
    throw new Error(`Unhandled fetch in test: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const callsTo = (mock: ReturnType<typeof stubFetch>, match: string) =>
  mock.mock.calls.filter(([input]) => String(input).includes(match)).length

const originalLocation = window.location
let reloadSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  reloadSpy = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  })
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearAccessToken()
  localStorage.clear()
})

describe('refresh across tabs (#19)', () => {
  it('waits about 300 ms after a REFRESH_RACE and retries once, which succeeds', async () => {
    vi.useFakeTimers()
    const fresh = makeToken('u1')
    const fetchMock = stubFetch({
      '/api/auth/refresh': [
        () => jsonResponse(401, { error: 'Refresh already used', code: 'REFRESH_RACE' }),
        () => jsonResponse(200, { accessToken: fresh, user: user('u1') }),
      ],
    })
    setAccessToken(makeToken('u1', 10))

    const outcome = tryRefreshToken()
    await vi.advanceTimersByTimeAsync(0)
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(1)
    await vi.advanceTimersByTimeAsync(299)
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(outcome).resolves.toBe(true)
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(2)
    expect(getAccessToken()).toBe(fresh)
  })

  it('a REFRESH_RACE that outlasts its retry fails without dropping the token', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch({
      '/api/auth/refresh': () => jsonResponse(401, { error: 'Refresh already used', code: 'REFRESH_RACE' }),
    })
    const current = makeToken('u1', 10)
    setAccessToken(current)

    const outcome = tryRefreshToken()
    await vi.advanceTimersByTimeAsync(400)

    await expect(outcome).resolves.toBe(false)
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(2)
    expect(getAccessToken()).toBe(current)
  })

  it('takes the pz-auth-refresh lock when navigator.locks exists, so tabs refresh one at a time', async () => {
    const request = vi.fn((_name: string, task: () => Promise<unknown>) => task())
    vi.stubGlobal('navigator', { ...navigator, locks: { request } })
    stubFetch({ '/api/auth/refresh': () => jsonResponse(200, { accessToken: makeToken('u1'), user: user('u1') }) })

    await expect(tryRefreshToken()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('pz-auth-refresh')
  })

  it('callers in one tab share one refresh request', async () => {
    const answer = deferred<Response>()
    const fetchMock = stubFetch({ '/api/auth/refresh': () => answer.promise })

    const first = tryRefreshToken()
    const second = refreshSession()
    answer.resolve(jsonResponse(200, { accessToken: makeToken('u1'), user: user('u1') }))

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toMatchObject({ ok: true, user: { id: 'u1' } })
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(1)
  })
})

describe('a failed refresh keeps the session unless the panel refused it (#20)', () => {
  it('a 503 from refresh keeps the existing token', async () => {
    stubFetch({ '/api/auth/refresh': () => jsonResponse(503, { error: 'Service unavailable' }) })
    const current = makeToken('u1', 30)
    setAccessToken(current)

    await expect(tryRefreshToken()).resolves.toBe(false)
    expect(getAccessToken()).toBe(current)
  })

  it('a 429 or a network error keeps it too', async () => {
    const current = makeToken('u1', 30)
    setAccessToken(current)
    stubFetch({ '/api/auth/refresh': () => jsonResponse(429, { error: 'Too many requests' }) })
    await expect(tryRefreshToken()).resolves.toBe(false)
    expect(getAccessToken()).toBe(current)

    stubFetch({ '/api/auth/refresh': () => Promise.reject(new TypeError('Failed to fetch')) })
    await expect(tryRefreshToken()).resolves.toBe(false)
    expect(getAccessToken()).toBe(current)
  })

  it('a 401 from refresh clears the token', async () => {
    stubFetch({ '/api/auth/refresh': () => jsonResponse(401, { error: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' }) })
    setAccessToken(makeToken('u1', 30))

    await expect(tryRefreshToken()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
  })

  it('the socket provider still sends the token it has after a 503 from refresh', async () => {
    stubFetch({ '/api/auth/refresh': () => jsonResponse(503, { error: 'Service unavailable' }) })
    const nearExpiry = makeToken('u1', 30)
    setAccessToken(nearExpiry)
    const callback = vi.fn()

    createSocketAuthProvider(getAccessToken, true)(callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    expect(callback).toHaveBeenCalledWith({ token: nearExpiry })
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('a request sent with no token that gets AUTH_REQUIRED refreshes and replays once', async () => {
    const fresh = makeToken('u1')
    const seen: Array<string | null> = []
    stubFetch({
      '/api/auth/refresh': () => jsonResponse(200, { accessToken: fresh, user: user('u1') }),
      '/api/players': (init) => {
        const auth = new Headers(init?.headers).get('Authorization')
        seen.push(auth)
        return auth
          ? jsonResponse(200, { players: [] })
          : jsonResponse(401, { error: 'Authentication required', code: 'AUTH_REQUIRED' })
      },
    })

    const response = await apiFetch('/players')

    expect(response.status).toBe(200)
    expect(seen).toEqual([null, `Bearer ${fresh}`])
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('AUTH_REQUIRED for a request that did carry a token is not a refresh case', async () => {
    const fetchMock = stubFetch({
      '/api/auth/refresh': () => jsonResponse(200, { accessToken: makeToken('u1'), user: user('u1') }),
      '/api/players': () => jsonResponse(401, { error: 'Authentication required', code: 'AUTH_REQUIRED' }),
    })
    setAccessToken(makeToken('u1'))

    const response = await apiFetch('/players')

    expect(response.status).toBe(401)
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(0)
  })
})

describe('a refresh never switches the tab to another account (#15)', () => {
  it('a refresh returning a different user does not set the token and reloads', async () => {
    const alice = makeToken('alice', 10)
    stubFetch({ '/api/auth/refresh': () => jsonResponse(200, { accessToken: makeToken('bob'), user: user('bob') }) })
    setAccessToken(alice)

    await expect(tryRefreshToken()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('the same user refreshes as usual', async () => {
    const fresh = makeToken('alice')
    stubFetch({ '/api/auth/refresh': () => jsonResponse(200, { accessToken: fresh, user: user('alice') }) })
    setAccessToken(makeToken('alice', 10))

    await expect(tryRefreshToken()).resolves.toBe(true)
    expect(getAccessToken()).toBe(fresh)
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})

describe('sign-out and a refresh in flight (#14)', () => {
  it('a refresh that resolves after sign-out started does not set a token, and logout waits for it', async () => {
    const refreshAnswer = deferred<Response>()
    const order: string[] = []
    stubFetch({
      '/api/auth/refresh': () => {
        order.push('refresh')
        return refreshAnswer.promise
      },
      '/api/auth/logout': () => {
        order.push('logout')
        return jsonResponse(200, { success: true })
      },
    })
    const current = makeToken('u1', 10)
    setAccessToken(current)

    const refresh = tryRefreshToken()
    const signOut = endServerSession()
    await Promise.resolve()
    expect(order).toEqual(['refresh'])

    refreshAnswer.resolve(jsonResponse(200, { accessToken: makeToken('u1'), user: user('u1') }))

    await expect(signOut).resolves.toBe(true)
    await expect(refresh).resolves.toBe(false)
    expect(order).toEqual(['refresh', 'logout'])
    expect(getAccessToken()).toBe(current)
  })

  it('a refresh asked for during a sign-out that succeeds never reaches the network', async () => {
    const logoutAnswer = deferred<Response>()
    const fetchMock = stubFetch({
      '/api/auth/logout': () => logoutAnswer.promise,
      '/api/auth/refresh': () => jsonResponse(200, { accessToken: makeToken('u1'), user: user('u1') }),
    })
    setAccessToken(makeToken('u1', 10))

    const signOut = endServerSession()
    const refresh = tryRefreshToken()
    logoutAnswer.resolve(jsonResponse(200, { success: true }))

    await expect(signOut).resolves.toBe(true)
    await expect(refresh).resolves.toBe(false)
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(0)
  })

  it('a sign-out the panel never confirmed resolves false', async () => {
    stubFetch({ '/api/auth/logout': () => jsonResponse(502, { error: 'Bad gateway' }) })
    await expect(endServerSession()).resolves.toBe(false)

    stubFetch({ '/api/auth/logout': () => Promise.reject(new TypeError('Failed to fetch')) })
    await expect(endServerSession()).resolves.toBe(false)
  })

  it('when the sign-out fails, the refresh it overtook still counts: the session stands', async () => {
    const refreshAnswer = deferred<Response>()
    const fresh = makeToken('u1')
    stubFetch({
      '/api/auth/refresh': () => refreshAnswer.promise,
      '/api/auth/logout': () => jsonResponse(502, { error: 'Bad gateway' }),
    })
    setAccessToken(makeToken('u1', 10))

    const refresh = tryRefreshToken()
    const signOut = endServerSession()
    refreshAnswer.resolve(jsonResponse(200, { accessToken: fresh, user: user('u1') }))

    await expect(signOut).resolves.toBe(false)
    await expect(refresh).resolves.toBe(true)
    expect(getAccessToken()).toBe(fresh)
  })
})
