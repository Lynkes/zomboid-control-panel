import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Login from '../Login'

// UX restructure (slice D, Login P2): the username field no longer suggests
// the literal account name "admin" (a placeholder is an example, and that
// one nudged people toward a guessable name); the heading carries its own
// weight with no kicker above it; and the panel's reachability reads as a
// StatusPill in the foreground colour instead of small red/green text.

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn() }),
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
})

describe('Login.tsx: auth screen polish', () => {
  it('has no "admin" placeholder and no kicker above the heading', async () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('placeholder', 'admin')
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.previousElementSibling).toBeNull()
    expect(screen.queryByText('Secure sign in')).not.toBeInTheDocument()
  })

  it('shows the panel as online once the health check answers', async () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    )
    const pill = await screen.findByText('Online')
    expect(pill.className).toMatch(/rounded-full/)
    expect(pill.className).toMatch(/text-foreground/)
  })
})
