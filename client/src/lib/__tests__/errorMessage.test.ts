import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
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

describe('getUserErrorMessage — error.code translation priority', () => {
  beforeEach(() => {
    void i18n.changeLanguage('fr')
  })

  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('prefers the registered translation over the server-provided English text', () => {
    const error = new ApiError('No active server configured', { code: 'SERVER_NOT_CONFIGURED' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Aucun serveur actif configuré')
  })

  it('maps a frozen legacy lower_snake_case wire code to its _LEGACY locale key', () => {
    const error = new ApiError('Stop the server before deleting chunks.', { code: 'server_running' })
    expect(getUserErrorMessage(error, 'fallback')).toContain('supprimer des chunks')
  })

  it('falls through to the server message when the code has no registered translation', () => {
    const error = new ApiError('Something very specific went wrong', { code: 'SOME_UNREGISTERED_CODE' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Something very specific went wrong')
  })

  it('falls through to the server message (unchanged from today) when the registered translation needs interpolation data the client does not have', () => {
    const error = new ApiError('A role named "Moderator" already exists', { code: 'ROLE_NAME_TAKEN' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  it('never surfaces an unresolved {{placeholder}} to the user', () => {
    const error = new ApiError('A role named "Moderator" already exists', { code: 'ROLE_NAME_TAKEN' })
    expect(getUserErrorMessage(error, 'fallback')).not.toMatch(/\{\{/)
  })

  it('still uses the fallback for an untranslated code with no server message', () => {
    const error = new ApiError('', { code: 'SOME_UNREGISTERED_CODE' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('fallback')
  })

  it('translation lookup does not affect English (the default fallback language)', () => {
    void i18n.changeLanguage('en')
    const error = new ApiError('No active server configured', { code: 'SERVER_NOT_CONFIGURED' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('No active server configured')
  })
})

describe('getUserErrorMessage — structured params interpolation', () => {
  beforeEach(() => {
    void i18n.changeLanguage('fr')
  })

  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('interpolates a registered translation once the server sends the matching param', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { name: 'Moderator' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Un rôle nommé « Moderator » existe déjà')
  })

  it('interpolates a numeric param', () => {
    const error = new ApiError('3 user(s) still hold this role.', {
      code: 'ROLE_HAS_MEMBERS',
      data: { params: { count: 3 } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "Ce rôle est encore détenu par 3 utilisateur(s). Indiquez reassignTo pour les réattribuer à un autre rôle d'abord.",
    )
  })

  it('resolves an action param through the capabilities label catalogue instead of showing the raw key', () => {
    const error = new ApiError('This change would leave no user able to manage roles.', {
      code: 'ROLE_LOCKOUT_LAST_MANAGER',
      data: { params: { action: 'roles.manage' } },
    })
    const message = getUserErrorMessage(error, 'fallback')
    expect(message).not.toContain('roles.manage')
    expect(message).not.toContain('{{')
    expect(message).toContain('Gérer les rôles et permissions')
  })

  it('falls back to the raw value for a capability param with no matching label (e.g. an invalid capability)', () => {
    const error = new ApiError('Unknown capability: not.a.real.capability', {
      code: 'INVALID_CAPABILITY',
      data: { params: { capability: 'not.a.real.capability' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Capacité inconnue : not.a.real.capability')
  })

  it('does not resolve capability labels for param names outside the closed list (e.g. name)', () => {
    const error = new ApiError('A role named "roles.manage" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { name: 'roles.manage' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Un rôle nommé « roles.manage » existe déjà')
  })

  it('falls through to the server text when params is missing the required key (malformed, not just absent)', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { wrongKey: 'Moderator' } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  it('falls through to the server text when params has the right key but a non-string/number value', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: { name: { nested: 'Moderator' } } },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })

  it('falls through to the server text when params itself is not an object (array)', () => {
    const error = new ApiError('A role named "Moderator" already exists', {
      code: 'ROLE_NAME_TAKEN',
      data: { params: ['Moderator'] },
    })
    expect(getUserErrorMessage(error, 'fallback')).toBe('A role named "Moderator" already exists')
  })
})
