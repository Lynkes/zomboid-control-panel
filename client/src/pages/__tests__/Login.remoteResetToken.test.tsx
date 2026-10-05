import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Login from '../Login'
import { getTrustedDeviceToken } from '../../lib/trustedDevice'

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
    if (url.includes('/api/auth/reset-password')) {
      return json(200, { success: true, message: 'Password reset for admin', username: 'admin', deviceToken: 'device-after-token-reset' })
    }
    if (url.includes('/api/auth/recover-with-code')) {
      return json(200, { success: true, message: 'Password reset for admin', username: 'admin', deviceToken: 'device-after-code-reset' })
    }
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
  localStorage.clear()
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

  // Round 2 of the A2 verification: the help said "a password generator",
  // and the server accepted phrases and number constants that a stranger
  // could guess. A hand-made token must now be a generator's hex output, and
  // the help says how to make one.
  it('the remote help asks for hex from a generator and shows the command', async () => {
    const fetchMock = stubServer({ recoveryCodesAvailable: false })
    await renderSettled(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /recover account/i }))
    await screen.findByRole('button', { name: /enter a recovery token/i })

    const command = screen.getByText('openssl rand -hex 24')
    expect(command).toHaveClass('font-mono')
    const help = command.closest('p')
    expect(help).toHaveTextContent(/random hex at least 32 characters long from a generator/i)
    expect(help).toHaveTextContent(/words, sentences, number sequences/i)
    expect(help?.textContent).not.toContain('<code>')
  })

  it('with recovery codes: the form opens on codes, and switching to a token sends it to /reset-password', async () => {
    const fetchMock = stubServer({ recoveryCodesAvailable: true })
    await renderSettled(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /use recovery token/i }))
    expect(screen.getByRole('button', { name: /^recovery code$/i })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /^recovery token$/i }))
    expect(screen.getByLabelText(/^recovery token$/i)).toBeInTheDocument()
    fillAndSubmit('3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59')

    await waitFor(() => expect(postedTo(fetchMock, '/api/auth/reset-password')).toBeTruthy())
    expect(postedTo(fetchMock, '/api/auth/recover-with-code')).toBeUndefined()
  })
})

// Security sweep 2026-10-05, A1 (round 1 of the verification): a reset
// retires every trusted-device token the account had, this browser's
// included. The server hands the browser that did it a fresh one, so its
// next sign-in still counts on its own rather than by address.
describe('Login.tsx: a reset keeps this browser trusted', () => {
  it('keeps the device token a reset-token reset hands back', async () => {
    const fetchMock = stubServer({ recoveryCodesAvailable: false })
    await renderSettled(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /recover account/i }))
    fireEvent.click(await screen.findByRole('button', { name: /enter a recovery token/i }))
    fillAndSubmit('3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59')

    await waitFor(() => expect(getTrustedDeviceToken('admin')).toBe('device-after-token-reset'))
  })

  it('keeps the device token a recovery-code reset hands back', async () => {
    const fetchMock = stubServer({ recoveryCodesAvailable: true })
    await renderSettled(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /use recovery token/i }))
    expect(screen.getByRole('button', { name: /^recovery code$/i })).toHaveAttribute('aria-pressed', 'true')
    fillAndSubmit('ABCDE-FGHIJ-KLMNO')

    await waitFor(() => expect(getTrustedDeviceToken('admin')).toBe('device-after-code-reset'))
  })
})

// Round 3 of the A2 verification: this screen asked for 8 characters while
// the server takes only hex digits, at least 32 of them, so it sent tokens
// the server could only refuse. It now says what a token is before sending
// one; recovery codes keep their own check (above).
describe('Login.tsx: a recovery token has to be hex of 32 digits or more', () => {
  async function openTokenForm() {
    const fetchMock = stubServer({ recoveryCodesAvailable: false })
    await renderSettled(fetchMock)
    fireEvent.click(screen.getByRole('button', { name: /recover account/i }))
    fireEvent.click(await screen.findByRole('button', { name: /enter a recovery token/i }))
    expect(screen.getByRole('button', { name: /^recovery token$/i })).toHaveAttribute('aria-pressed', 'true')
    return fetchMock
  }

  it.each([
    ['a phrase', 'a-token-the-operator-wrote-on-the-host-0123'],
    ['too few hex digits', 'deadbeef12'],
    ['31 hex digits in groups', '0123abcd-4567-89ab-cdef-0123456789a'],
    ['base64', 'phb20kHwWx7/1dtNtaxPYs9WAnvC2tGm'],
    ['hex with a space in it', '3f9a0c7be15d42a8960e7d1f b4c2a95e0d63b8f1c7a24e59'],
  ])('refuses %s without sending it', async (_label, token) => {
    const fetchMock = await openTokenForm()
    fillAndSubmit(token)
    expect(await screen.findByText(/random hex \(0-9 and a-f\) at least 32 characters long/i)).toBeInTheDocument()
    expect(postedTo(fetchMock, '/api/auth/reset-password')).toBeUndefined()
  })

  it.each([
    ['48 hex digits (openssl rand -hex 24)', '3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59'],
    ['32 upper-case hex digits', '9C41E07B2DA85F36B1E40C7D92A3F58E'],
    ['a UUID (New-Guid)', '1b4e28ba-2fa1-41d2-883f-0016d3cca427'],
    ['hex with spaces around it, as copied from the file', '  3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59 '],
  ])('sends %s', async (_label, token) => {
    const fetchMock = await openTokenForm()
    fillAndSubmit(token)
    await waitFor(() => expect(postedTo(fetchMock, '/api/auth/reset-password')).toBeTruthy())
    const body = JSON.parse(String(postedTo(fetchMock, '/api/auth/reset-password')?.[1]?.body))
    expect(body.token).toBe(token)
  })
})
