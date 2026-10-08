import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../AuthContext'
import { Toaster } from '../../components/ui/toaster'
import { clearAccessToken, getAccessToken } from '../../lib/authToken'

// Auth audit 2026-10-08, client session items: the boot check (#23), the
// shared boot refresh (#19) and sign-out that must reach the panel (#14).

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeToken(userId: string): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${base64url({ alg: 'HS256' })}.${base64url({ userId, exp: Math.floor(Date.now() / 1000) + 900 })}.sig`
}

const admin = { id: 'u-admin', username: 'admin', role: 'admin', capabilities: null }

type Route = () => Response | Promise<Response>

function stubFetch(routes: Record<string, Route | Route[]>) {
  const calls: Record<string, number> = {}
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [match, route] of Object.entries(routes)) {
      if (!url.includes(match)) continue
      const index = calls[match] ?? 0
      calls[match] = index + 1
      const respond = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route
      return respond()
    }
    throw new Error(`Unhandled fetch in test: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const callsTo = (mock: ReturnType<typeof stubFetch>, match: string) =>
  mock.mock.calls.filter(([input]) => String(input).includes(match)).length

const signedInRoutes = {
  '/api/auth/status': () => jsonResponse(200, { needsSetup: false, authEnabled: true }),
  '/api/auth/refresh': () => jsonResponse(200, { accessToken: makeToken('u-admin'), user: admin }),
}

// The same gate App.tsx renders from this state.
function Screen() {
  const { isLoading, statusCheckFailed, needsSetup, authEnabled, isAuthenticated, user, logout, retryAuthCheck } = useAuth()
  let view = 'panel'
  if (isLoading) view = 'loading'
  else if (statusCheckFailed) view = 'status-error'
  else if (needsSetup) view = 'setup'
  else if (authEnabled && !isAuthenticated) view = 'login'
  return (
    <div>
      <div data-testid="view">{view}</div>
      <div data-testid="user">{user?.username ?? ''}</div>
      <button onClick={() => { void logout() }}>sign out</button>
      <button onClick={retryAuthCheck}>retry check</button>
    </div>
  )
}

function renderApp() {
  return render(
    <AuthProvider>
      <Screen />
      <Toaster />
    </AuthProvider>,
  )
}

const view = () => screen.getByTestId('view').textContent

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearAccessToken()
  localStorage.clear()
})

describe('boot check: only a real answer turns logins off (#23)', () => {
  it('a 503 from /api/auth/status shows the error card, not the panel', async () => {
    stubFetch({ '/api/auth/status': () => jsonResponse(503, { error: 'Service unavailable' }) })
    renderApp()
    await waitFor(() => expect(view()).toBe('status-error'))
  })

  it("a proxy's HTML page shows the error card, not the panel", async () => {
    stubFetch({
      '/api/auth/status': () => new Response('<html><body>Sign in with your proxy</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    })
    renderApp()
    await waitFor(() => expect(view()).toBe('status-error'))
  })

  it('a network error shows the error card, and Retry checks again', async () => {
    const fetchMock = stubFetch({
      '/api/auth/status': [
        () => Promise.reject(new TypeError('Failed to fetch')),
        () => jsonResponse(200, { needsSetup: false, authEnabled: true }),
      ],
      '/api/auth/refresh': () => jsonResponse(401, { error: 'No refresh token', code: 'NO_REFRESH_TOKEN' }),
    })
    renderApp()
    await waitFor(() => expect(view()).toBe('status-error'))

    fireEvent.click(screen.getByText('retry check'))
    await waitFor(() => expect(view()).toBe('login'))
    expect(callsTo(fetchMock, '/api/auth/status')).toBe(2)
  })

  it('an explicit { authEnabled: false } still means logins are off', async () => {
    stubFetch({ '/api/auth/status': () => jsonResponse(200, { needsSetup: false, authEnabled: false }) })
    renderApp()
    await waitFor(() => expect(view()).toBe('panel'))
  })

  it('a JSON answer without authEnabled is not read as logins off', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse(200, { needsSetup: false }),
      '/api/auth/refresh': () => jsonResponse(401, { error: 'No refresh token', code: 'NO_REFRESH_TOKEN' }),
    })
    renderApp()
    await waitFor(() => expect(view()).toBe('login'))
  })
})

describe('boot refresh goes through the shared refresh (#19)', () => {
  it('a REFRESH_RACE at load is retried and signs in', async () => {
    const fetchMock = stubFetch({
      '/api/auth/status': signedInRoutes['/api/auth/status'],
      '/api/auth/refresh': [
        () => jsonResponse(401, { error: 'Refresh already used', code: 'REFRESH_RACE' }),
        signedInRoutes['/api/auth/refresh'],
      ],
    })
    renderApp()
    await waitFor(() => expect(view()).toBe('panel'))
    expect(screen.getByTestId('user').textContent).toBe('admin')
    expect(callsTo(fetchMock, '/api/auth/refresh')).toBe(2)
  })
})

// Last: the failure toast stays a minute in the toast store every Toaster
// in this file shares.
describe('sign-out has to reach the panel (#14)', () => {
  it('a 502 from /logout keeps the session and shows the error with Retry, which then signs out', async () => {
    const fetchMock = stubFetch({
      ...signedInRoutes,
      '/api/auth/logout': [
        () => jsonResponse(502, { error: 'Bad gateway' }),
        () => jsonResponse(200, { success: true }),
      ],
    })
    renderApp()
    await waitFor(() => expect(view()).toBe('panel'))

    fireEvent.click(screen.getByText('sign out'))

    expect(await screen.findByText('Sign-out did not reach the panel')).toBeInTheDocument()
    expect(view()).toBe('panel')
    expect(screen.getByTestId('user').textContent).toBe('admin')
    expect(getAccessToken()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(view()).toBe('login'))
    expect(callsTo(fetchMock, '/api/auth/logout')).toBe(2)
    expect(getAccessToken()).toBeNull()
  })
})
