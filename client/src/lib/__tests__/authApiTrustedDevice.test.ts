import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '../api'
import { getTrustedDeviceToken, rememberTrustedDeviceToken } from '../trustedDevice'

// Security sweep 2026-10-05, A1 (round 1 of the verification): changing the
// password, or regenerating the JWT secret, retires every trusted-device
// token the account had -- this browser's included -- and signs it out.
// The server now hands this browser a fresh one with the response; without
// keeping it, the next sign-in here was counted by address, the very count a
// stranger keeps paused, so the owner who had just changed the password was
// refused from this browser.

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  rememberTrustedDeviceToken('admin', 'retired-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('authApi keeps the trusted-device token a password change or key rotation returns', () => {
  it('changePassword', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: true, message: 'Password changed successfully', username: 'admin', deviceToken: 'after-change' }),
    )
    await expect(authApi.changePassword('old-password', 'new-password-1')).resolves.toMatchObject({ success: true })
    expect(getTrustedDeviceToken('admin')).toBe('after-change')
  })

  it('regenerateJwtSecret', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: true, message: 'JWT signing key regenerated.', username: 'admin', deviceToken: 'after-rotation' }),
    )
    await authApi.regenerateJwtSecret()
    expect(getTrustedDeviceToken('admin')).toBe('after-rotation')
  })

  it('a failed change keeps what this browser had', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Current password is incorrect' }, 400))
    await expect(authApi.changePassword('wrong', 'new-password-1')).rejects.toThrow()
    expect(getTrustedDeviceToken('admin')).toBe('retired-token')
  })
})
