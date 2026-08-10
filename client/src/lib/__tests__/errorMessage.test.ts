import { describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import { getRecoveryUrl, getUserErrorMessage } from '../errorMessage'

describe('getRecoveryUrl', () => {
  it('uses the server-provided recovery destination', () => {
    expect(getRecoveryUrl(new ApiError('Bridge not running', { data: { fixUrl: '/settings?tab=bridge' } }))).toBe('/settings?tab=bridge')
  })

  it('maps established RCON failures to connection settings', () => {
    expect(getRecoveryUrl(new Error('RCON authentication failed'))).toBe('/settings?tab=connection')
  })

  it('does not create a destination for unrelated failures', () => {
    expect(getRecoveryUrl(new Error('Network timeout'))).toBeNull()
  })
})

class MockApiError extends Error {
  status?: number
  code?: string
  isRetryable = false
  isTimeout = false
  isNetworkError = false

  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

describe('getUserErrorMessage', () => {
  it('returns the error message for a standard Error', () => {
    expect(getUserErrorMessage(new Error('Connection lost'), 'fallback')).toBe('Connection lost')
  })

  it('returns fallback for empty error message', () => {
    expect(getUserErrorMessage(new Error(''), 'Something went wrong')).toBe('Something went wrong')
  })

  it('returns fallback for "unknown error" message (case-insensitive)', () => {
    expect(getUserErrorMessage(new Error('Unknown Error'), 'fallback')).toBe('fallback')
  })

  it('returns fallback for non-error objects without message', () => {
    expect(getUserErrorMessage(42, 'fallback')).toBe('fallback')
    expect(getUserErrorMessage(null, 'fallback')).toBe('fallback')
    expect(getUserErrorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('extracts message from plain objects with message property', () => {
    expect(getUserErrorMessage({ message: 'server down' }, 'fallback')).toBe('server down')
  })

  it('returns fallback for plain objects with empty message', () => {
    expect(getUserErrorMessage({ message: '' }, 'fallback')).toBe('fallback')
  })
})
