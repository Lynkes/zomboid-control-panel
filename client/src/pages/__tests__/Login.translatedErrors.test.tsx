import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import Login from '../Login'
import frLogin from '../../locales/fr/login.json'
import deLogin from '../../locales/de/login.json'
import frErrors from '../../locales/fr/errors.json'
import deErrors from '../../locales/de/errors.json'

// login() throws coded errors (LOGIN_FAILED, LOGIN_CORS_BLOCKED, or the
// transport/server error itself); the form used to print error.message raw,
// so a wrong password read in English whatever the language.
const loginFn = vi.fn()

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: loginFn }),
}))

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = String(url)
    if (u.includes('/api/health')) return Promise.resolve({ ok: true, json: async () => ({ version: '1.0.0' }) } as Response)
    if (u.includes('/api/auth/reset-status')) return Promise.resolve({ ok: true, json: async () => ({ resetAvailable: false, localResetSupported: false }) } as Response)
    if (u.includes('/api/auth/recovery-status')) return Promise.resolve({ ok: true, json: async () => ({ recoveryCodesAvailable: false }) } as Response)
    if (u.includes('/api/auth/oidc/status')) return Promise.resolve({ ok: true, json: async () => ({ configured: false }) } as Response)
    throw new Error(`unexpected fetch in test: ${u}`)
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  void i18n.changeLanguage('en')
})

// Signs in with a wrong password and returns the error box the form shows.
async function submitSignIn(labels: { usernameLabel: string; passwordLabel: string }) {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText(labels.usernameLabel), { target: { value: 'someone' } })
  fireEvent.change(screen.getByLabelText(labels.passwordLabel), { target: { value: 'wrong' } })
  fireEvent.submit(document.querySelector('#login-form') as HTMLFormElement)
  return screen.findByRole('alert')
}

describe('Login.tsx: sign-in failures are shown in the active language', () => {
  it('shows the wrong-password text translated', async () => {
    void i18n.changeLanguage('fr')
    loginFn.mockRejectedValue(new ApiError("We couldn't sign you in. Check your username and password and try again.", { status: 401, code: 'LOGIN_FAILED' }))
    expect(await submitSignIn(frLogin.signIn)).toHaveTextContent(frErrors.LOGIN_FAILED)
  })

  it('shows the blocked-origin text translated', async () => {
    void i18n.changeLanguage('de')
    loginFn.mockRejectedValue(new ApiError('Connection blocked by browser origin policy.', { code: 'LOGIN_CORS_BLOCKED' }))
    expect(await submitSignIn(deLogin.signIn)).toHaveTextContent(deErrors.LOGIN_CORS_BLOCKED)
  })

  it('shows a rate limit in the translation of the code the server sent', async () => {
    void i18n.changeLanguage('fr')
    loginFn.mockRejectedValue(new ApiError('Too many login attempts. Please try again later.', { status: 429, code: 'RATE_LIMIT_LOGIN' }))
    expect(await submitSignIn(frLogin.signIn)).toHaveTextContent(frErrors.RATE_LIMIT_LOGIN)
  })
})
