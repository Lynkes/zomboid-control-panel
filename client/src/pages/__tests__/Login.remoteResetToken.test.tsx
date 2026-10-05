import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Login from '../Login'

// Security sweep 2026-10-05, A2: GET /api/auth/reset-status used to tell
// anyone whether data/reset-token.txt existed, and this screen only offered
// remote users the token field once that flag said so ("Check token"). The
// flag let a stranger watch for the operator's token and delete it with a
// few wrong guesses. The server now reports it to the panel host only, so a
// remote user must always be able to choose to enter a token themselves,
// next to recovery codes.

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn() }),
}))

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubServer({ recoveryCodesAvailable }: { recoveryCodesAvailable: boolean }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/health')) return json(200, { version: '1.0.0' })
    if (url.includes('/api/auth/oidc/status')) return json(200, { configured: false })
    // What a remote browser gets now: no resetAvailable at all.
    if (url.includes('/api/auth/reset-status')) return json(200, { localResetSupported: false })
    if (url.includes('/api/auth/recovery-status')) return json(200, { recoveryCodesAvailable })
    if (url.includes('/api/auth/reset-token/local')) {
      return json(403, {
        error: 'This recovery action is only available when the panel is opened from the server itself.',
        code: 'LOCAL_RESET_NOT_LOCAL',
      })
    }
    if (url.includes('/api/auth/reset-password')) return json(200, { success: true, message: 'Password reset for admin' })
    if (url.includes('/api/auth/recover-with-code')) return json(200, { success: true, message: 'Password reset for admin' })
    throw new Error(`unexpected fetch in test: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function renderSettled(fetchMock: ReturnType<typeof stubServer>) {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )
  // Let both mount-time status checks settle.
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/auth/recovery-status'))).toBe(true),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function fillAndSubmit(token: string) {
  fireEvent.change(screen.getByLabelText(/^recovery (token|code)$/i), { target: { value: token } })
  fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'new-password-1' } })
  fireEvent.change(screen.getByLabelText(/^confirm password$/i), { target: { value: 'new-password-1' } })
  fireEvent.click(screen.getByRole('button', { name: /^reset password$/i }))
}

function postedTo(fetchMock: ReturnType<typeof stubServer>, path: string) {
  return fetchMock.mock.calls.find(([input]) => String(input).includes(path))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Login.tsx: a remote user can always enter a reset token', () => {
  it('without recovery codes: the remote help offers token entry, and the token goes to /reset-password', async () => {
    const fetchMock = stubServer({ recoveryCodesAvailable: false })
    await renderSettled(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /recover account/i }))
    const enterToken = await screen.findByRole('button', { name: /enter a recovery token/i })
    fireEvent.click(enterToken)

    expect(screen.getByRole('button', { name: /^recovery token$/i })).toHaveAttribute('aria-pressed', 'true')
    const token = 'f'.repeat(8) + '0123456789abcdef0a1b2c3d4e5f6a7b'
    fillAndSubmit(token)

    await waitFor(() => expect(postedTo(fetchMock, '/api/auth/reset-password')).toBeTruthy())
    const body = JSON.parse(String(postedTo(fetchMock, '/api/auth/reset-password')?.[1]?.body))
    expect(body).toEqual({ token, newPassword: 'new-password-1' })
  })

  it('with recovery codes: the form opens on codes, and switching to a token sends it to /reset-password', async () => {
    const fetchMock = stubServer({ recoveryCodesAvailable: true })
    await renderSettled(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /use recovery token/i }))
    expect(screen.getByRole('button', { name: /^recovery code$/i })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /^recovery token$/i }))
    expect(screen.getByLabelText(/^recovery token$/i)).toBeInTheDocument()
    fillAndSubmit('a-token-the-operator-wrote-on-the-host-0123')

    await waitFor(() => expect(postedTo(fetchMock, '/api/auth/reset-password')).toBeTruthy())
    expect(postedTo(fetchMock, '/api/auth/recover-with-code')).toBeUndefined()
  })
})
