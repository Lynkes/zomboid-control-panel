import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { AuthProvider, useAuth } from '../AuthContext'
import { getTrustedDeviceToken, rememberTrustedDeviceToken } from '../../lib/trustedDevice'
import { clearAccessToken } from '../../lib/authToken'

// Security sweep 2026-10-05, A1: the server counts failed sign-ins per
// client address, and a stranger could fill that table, or share the
// owner's address behind a proxy, and get the owner's browser refused. A
// successful sign-in now returns a device token; this browser has to keep
// it per username and send it with that account's later sign-ins (and pick
// up a fresh one from first-run setup and from a session refresh -- the
// first thing that happens after coming back from SSO).

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const user = { id: 'u-admin', username: 'Admin', role: 'admin', capabilities: null }

function Harness({ action }: { action: 'login' | 'setup' }) {
  const { login, setup } = useAuth()
  const [done, setDone] = useState(false)
  return (
    <div>
      <button
        onClick={() => {
          const run = action === 'login' ? login('admin', 'pw') : setup('Admin', 'password123')
          run.then(() => setDone(true)).catch(() => setDone(true))
        }}
      >
        go
      </button>
      {done && <div data-testid="done" />}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  // A signed-in harness leaves its access token behind; the next mount
  // would then try /me instead of the refresh under test.
  clearAccessToken()
})

function stubFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [match, respond] of Object.entries(routes)) {
      if (url.includes(match)) return respond(init)
    }
    if (url.includes('/api/auth/status')) return jsonResponse(200, { needsSetup: false, authEnabled: true })
    if (url.includes('/api/auth/refresh')) return jsonResponse(401, { error: 'no session' })
    throw new Error(`Unhandled fetch in test: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function clickGo() {
  await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())
  act(() => { screen.getByRole('button').click() })
  await waitFor(() => expect(screen.getByTestId('done')).toBeInTheDocument())
}

describe('AuthContext: trusted-device tokens', () => {
  it('login() sends the token this browser holds for that username, and keeps the new one', async () => {
    rememberTrustedDeviceToken('admin', 'old-device-token')
    const fetchMock = stubFetch({
      '/api/auth/login': () => jsonResponse(200, { accessToken: 'a', user, deviceToken: 'new-device-token' }),
    })
    render(<AuthProvider><Harness action="login" /></AuthProvider>)
    await clickGo()

    const loginCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/auth/login'))
    expect(JSON.parse(String(loginCall?.[1]?.body))).toMatchObject({ username: 'admin', deviceToken: 'old-device-token' })
    expect(getTrustedDeviceToken('admin')).toBe('new-device-token')
  })

  it('a failed login keeps the token it had', async () => {
    rememberTrustedDeviceToken('admin', 'old-device-token')
    stubFetch({ '/api/auth/login': () => jsonResponse(401, { error: 'Invalid username or password' }) })
    render(<AuthProvider><Harness action="login" /></AuthProvider>)
    await clickGo()
    expect(getTrustedDeviceToken('admin')).toBe('old-device-token')
  })

  it('first-run setup keeps the token it returns', async () => {
    stubFetch({
      '/api/auth/setup': () => jsonResponse(201, { accessToken: 'a', user, deviceToken: 'setup-device-token' }),
    })
    render(<AuthProvider><Harness action="setup" /></AuthProvider>)
    await clickGo()
    expect(getTrustedDeviceToken('admin')).toBe('setup-device-token')
  })

  it('a session refresh on load (how a browser back from SSO signs in) keeps the token it returns', async () => {
    stubFetch({
      '/api/auth/refresh': () => jsonResponse(200, { accessToken: 'a', user, deviceToken: 'refresh-device-token' }),
    })
    render(<AuthProvider><Harness action="login" /></AuthProvider>)
    await waitFor(() => expect(getTrustedDeviceToken('admin')).toBe('refresh-device-token'))
  })
})
