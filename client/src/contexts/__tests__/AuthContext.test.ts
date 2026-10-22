import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  getLoginErrorMessage,
  LOGIN_CORS_BLOCKED_CODE,
  LOGIN_FAILED_CODE,
  LOGIN_FAILED_MESSAGE,
  SETUP_FAILED_CODE,
  toLoginError,
} from '@/lib/loginError'

// 2026-08-26: login()'s fetch used to discard response status/code entirely,
// throwing a plain Error whose message getLoginErrorMessage() always
// collapsed to one of two fixed strings (network/CORS, or this generic
// auth-failed text) regardless of whether the underlying failure was a real
// auth rejection or a server crash. These pin the fix: a coded/uncoded 5xx
// is no longer swallowed into the same text an actual wrong-password
// response gets, while every existing case (network error, CORS, 4xx auth
// failure) stays byte-identical to preserve the account-enumeration ruling.
describe('getLoginErrorMessage', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('maps a network TypeError to the CORS/connectivity message', () => {
    expect(getLoginErrorMessage(new TypeError('Failed to fetch'))).toContain('Connection blocked by browser origin policy')
  })

  it('maps a cors-flavored Error message to the same CORS message', () => {
    expect(getLoginErrorMessage(new Error('CORS request did not succeed'))).toContain('Connection blocked by browser origin policy')
  })

  it('keeps the exact generic auth-failed text for a 401 -- the enumeration-safe case, unchanged', () => {
    const error = new ApiError('Invalid username or password', { status: 401 })
    expect(getLoginErrorMessage(error)).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('keeps the exact generic auth-failed text for a 400', () => {
    const error = new ApiError('Username and password are required', { status: 400 })
    expect(getLoginErrorMessage(error)).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('does NOT collapse a genuine 500 into the generic auth-failed text -- this is the actual fix', () => {
    const error = new ApiError('Database connection failed', { status: 500 })
    const message = getLoginErrorMessage(error)
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Database connection failed')
  })

  it('translates a registered 5xx-adjacent code the same way getUserErrorMessage does everywhere else', () => {
    void i18n.changeLanguage('fr')
    const error = new ApiError('Some unexpected failure', { status: 503 })
    expect(getLoginErrorMessage(error)).toContain("n'était pas attendu")
  })

  // bug-hunt-2026-09-07: RATE_LIMIT_LOGIN used to be swallowed into
  // LOGIN_FAILED_MESSAGE ("check your username and password") right along
  // with a real wrong-password 401 -- actively wrong, not merely generic,
  // since a rate-limited user is told to recheck credentials that were
  // never the problem. Telling the truth about rate-limiting reveals
  // nothing about whether the account exists, so it doesn't need the
  // enumeration-safe collapse the 401/400 cases above still correctly get.
  it('does NOT collapse a 429 rate-limit into the generic auth-failed text -- shows its own registered message instead', () => {
    const error = new ApiError('Too many login attempts. Please try again later.', {
      status: 429,
      code: 'RATE_LIMIT_LOGIN',
    })
    const message = getLoginErrorMessage(error)
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Too many login attempts')
  })

  it('falls back to the generic text for a non-ApiError, non-network error', () => {
    expect(getLoginErrorMessage(new Error('something else'))).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('falls back to the generic text for a non-error value', () => {
    expect(getLoginErrorMessage('a plain string')).toBe(LOGIN_FAILED_MESSAGE)
  })
})

// The wrong-password, blocked-origin and setup-failed texts were plain
// English strings thrown by login()/setup(), shown raw by the screens: they
// stayed English in every language. They are coded errors now, and
// errors.json (all 10 locales) holds the wording.
describe('toLoginError: coded, translatable errors', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('codes an auth failure LOGIN_FAILED and keeps the status', () => {
    const error = toLoginError(new ApiError('Invalid username or password', { status: 401 }))
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe(LOGIN_FAILED_CODE)
    expect(error.status).toBe(401)
    expect(error.message).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('codes a blocked origin LOGIN_CORS_BLOCKED, for a raw TypeError and for the transport NETWORK_ERROR alike', () => {
    expect(toLoginError(new TypeError('Failed to fetch')).code).toBe(LOGIN_CORS_BLOCKED_CODE)
    const network = new ApiError('Unable to reach the server.', { code: 'NETWORK_ERROR', isNetworkError: true })
    expect(toLoginError(network).code).toBe(LOGIN_CORS_BLOCKED_CODE)
  })

  it('hands a 5xx, a 429 and a timeout through untouched so their own code and text survive', () => {
    const serverError = new ApiError('Database connection failed', { status: 500, code: 'HTTP_500' })
    expect(toLoginError(serverError)).toBe(serverError)
    const limited = new ApiError('Too many login attempts.', { status: 429, code: 'RATE_LIMIT_LOGIN' })
    expect(toLoginError(limited)).toBe(limited)
    const timeout = new ApiError('The request timed out.', { code: 'TIMEOUT', isTimeout: true })
    expect(toLoginError(timeout)).toBe(timeout)
  })

  it('shows a timeout as a timeout, not as a wrong password', () => {
    const timeout = new ApiError('The request timed out. Check your connection and try again.', { code: 'TIMEOUT', isTimeout: true })
    expect(getLoginErrorMessage(timeout)).toBe('The request timed out. Check your connection and try again.')
    expect(getLoginErrorMessage(timeout)).not.toBe(LOGIN_FAILED_MESSAGE)
  })

  it('translates the wrong-password text', () => {
    void i18n.changeLanguage('fr')
    const message = getUserErrorMessage(toLoginError(new ApiError('Invalid username or password', { status: 401 })), 'fallback')
    expect(message).toBe("Connexion impossible. Vérifiez votre nom d'utilisateur et votre mot de passe, puis réessayez.")
    expect(getLoginErrorMessage(new ApiError('Invalid username or password', { status: 401 }))).toBe(message)
  })

  it('translates the blocked-origin text', () => {
    void i18n.changeLanguage('de')
    const message = getLoginErrorMessage(new TypeError('Failed to fetch'))
    expect(message).toContain('Origin-Richtlinie des Browsers')
    expect(message).toContain('CORS_ORIGINS')
  })

  it.each(['de', 'fr', 'es', 'pt-BR', 'uk', 'zh-CN', 'zh-TW', 'ar', 'ht'])('%s has all three texts, none of them English', (lang) => {
    void i18n.changeLanguage(lang)
    expect(getLoginErrorMessage(new ApiError('nope', { status: 401 }))).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(getLoginErrorMessage(new TypeError('Failed to fetch'))).not.toContain('Connection blocked')
    expect(getUserErrorMessage(new ApiError("We couldn't create the admin account. Try again.", { code: SETUP_FAILED_CODE }), 'fallback')).not.toContain("couldn't create")
  })
})
