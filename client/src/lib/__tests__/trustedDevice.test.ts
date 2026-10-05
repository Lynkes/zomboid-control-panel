import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTrustedDeviceToken, rememberTrustedDeviceFrom, rememberTrustedDeviceToken } from '../trustedDevice'

// Security sweep 2026-10-05, A1: the device token a successful sign-in
// returns is kept per username and sent with that account's later sign-ins,
// so the server counts this browser's attempts on their own (see
// lib/trustedDevice.ts and server/services/auth.js).

const STORAGE_KEY = 'pz-login-trusted-devices'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('trusted-device tokens in this browser', () => {
  it('are kept per username, case-insensitively, and replaced by the newest one', () => {
    rememberTrustedDeviceToken('Admin', 'token-1')
    rememberTrustedDeviceToken('mod', 'token-mod')
    expect(getTrustedDeviceToken('admin')).toBe('token-1')
    rememberTrustedDeviceToken('admin', 'token-2')
    expect(getTrustedDeviceToken('ADMIN')).toBe('token-2')
    expect(getTrustedDeviceToken('mod')).toBe('token-mod')
    expect(getTrustedDeviceToken('nobody')).toBeUndefined()
  })

  it('ignore nonsense from the server or storage instead of throwing', () => {
    rememberTrustedDeviceToken(undefined, 'token')
    rememberTrustedDeviceToken('admin', undefined)
    rememberTrustedDeviceToken('admin', 'x'.repeat(5000))
    expect(getTrustedDeviceToken('admin')).toBeUndefined()

    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(getTrustedDeviceToken('admin')).toBeUndefined()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'u:admin': { token: 42 } }))
    expect(getTrustedDeviceToken('admin')).toBeUndefined()
  })

  it('a username like __proto__ is just another username', () => {
    rememberTrustedDeviceToken('__proto__', 'proto-token')
    expect(getTrustedDeviceToken('__proto__')).toBe('proto-token')
    expect(({} as Record<string, unknown>).token).toBeUndefined()
  })

  it('remember at most 10 accounts, dropping the oldest', () => {
    const now = vi.spyOn(Date, 'now')
    for (let i = 0; i < 12; i++) {
      now.mockReturnValue(1_000 + i)
      rememberTrustedDeviceToken(`user${i}`, `token-${i}`)
    }
    expect(getTrustedDeviceToken('user0')).toBeUndefined()
    expect(getTrustedDeviceToken('user1')).toBeUndefined()
    expect(getTrustedDeviceToken('user2')).toBe('token-2')
    expect(getTrustedDeviceToken('user11')).toBe('token-11')
  })

  // Round 1 of the A1 verification: changing the password (or resetting it,
  // or rotating the JWT secret) retired this browser's token and the client
  // kept none in its place, so its next sign-in was counted by address again.
  it('are taken from a password change, reset or key rotation response', () => {
    rememberTrustedDeviceToken('admin', 'retired-token')
    rememberTrustedDeviceFrom({ success: true, message: 'Password changed successfully', username: 'admin', deviceToken: 'fresh-token' })
    expect(getTrustedDeviceToken('admin')).toBe('fresh-token')

    for (const response of [null, undefined, 'admin', { username: 'admin' }, { deviceToken: 'orphan' }]) {
      expect(() => rememberTrustedDeviceFrom(response)).not.toThrow()
    }
    expect(getTrustedDeviceToken('admin')).toBe('fresh-token')
  })

  it('carry on without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => rememberTrustedDeviceToken('admin', 'token')).not.toThrow()
    expect(getTrustedDeviceToken('admin')).toBeUndefined()
  })
})
