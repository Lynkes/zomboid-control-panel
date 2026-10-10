import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { LANGUAGES } from '@/i18n/languages'
import { ApiError, buildResponseError } from '../api'
import { getUserErrorMessage } from '../errorMessage'

// The client's own failures (the browser could not reach the panel, the
// request timed out, or the panel's reply carried no message of its own)
// used to show English in every locale: api.ts wrote the sentence, errors.json
// had no key for NETWORK_ERROR / TIMEOUT / the stock HTTP texts, so
// getUserErrorMessage() fell through to the raw English message.

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'content-type': 'application/json', ...headers } })
}

function networkError(): ApiError {
  return new ApiError('Unable to reach the server. Check your network connection and try again.', {
    code: 'NETWORK_ERROR',
    isRetryable: true,
    isNetworkError: true,
  })
}

afterEach(() => {
  void i18n.changeLanguage('en')
})

describe('getUserErrorMessage: client transport errors are translated', () => {
  it('keeps the English wording for English', () => {
    expect(getUserErrorMessage(networkError(), 'fallback')).toBe(
      'Unable to reach the server. Check your network connection and try again.',
    )
    const timeout = new ApiError('The request timed out. Check your connection and try again.', { code: 'TIMEOUT' })
    expect(getUserErrorMessage(timeout, 'fallback')).toBe('The request timed out. Check your connection and try again.')
  })

  it('shows NETWORK_ERROR and TIMEOUT in the active language', () => {
    void i18n.changeLanguage('fr')
    expect(getUserErrorMessage(networkError(), 'fallback')).toBe(
      'Impossible de joindre le serveur. Vérifiez votre connexion réseau et réessayez.',
    )
    const timeout = new ApiError('The request timed out. Check your connection and try again.', { code: 'TIMEOUT' })
    expect(getUserErrorMessage(timeout, 'fallback')).toBe('La requête a expiré. Vérifiez votre connexion et réessayez.')
  })

  it.each(LANGUAGES.map((l) => l.code).filter((code) => code !== 'en'))('%s does not fall back to English', (lang) => {
    void i18n.changeLanguage(lang)
    const english = 'Unable to reach the server. Check your network connection and try again.'
    expect(getUserErrorMessage(networkError(), 'fallback')).not.toBe(english)
    expect(getUserErrorMessage(buildResponseError(response(404), null), 'fallback')).not.toBe(
      'The requested resource was not found.',
    )
    expect(getUserErrorMessage(buildResponseError(response(502), null), 'fallback')).not.toBe(
      'The server is temporarily unavailable. Try again shortly.',
    )
    expect(getUserErrorMessage(buildResponseError(response(418), null), 'fallback')).not.toBe(
      'Request failed with status 418.',
    )
  })
})

describe('getUserErrorMessage: a response with no message of its own', () => {
  it('translates the stock text for the status', () => {
    void i18n.changeLanguage('de')
    expect(getUserErrorMessage(buildResponseError(response(403), null), 'fallback')).toBe(
      'Du hast keine Berechtigung für diese Aktion.',
    )
    expect(getUserErrorMessage(buildResponseError(response(404), {}), 'fallback')).toBe(
      'Die angeforderte Ressource wurde nicht gefunden.',
    )
  })

  it('uses the 5xx family text for every 5xx, including a Cloudflare 524', () => {
    void i18n.changeLanguage('es')
    const expected = 'El servidor no está disponible temporalmente. Inténtalo de nuevo en breve.'
    expect(getUserErrorMessage(buildResponseError(response(502), null), 'fallback')).toBe(expected)
    expect(getUserErrorMessage(buildResponseError(response(524), null), 'fallback')).toBe(expected)
  })

  it('names the status for a 4xx without a stock text of its own', () => {
    void i18n.changeLanguage('pt-BR')
    expect(getUserErrorMessage(buildResponseError(response(418), null), 'fallback')).toBe(
      'A solicitação falhou com o status 418.',
    )
  })

  it('keeps the English fallback text on the error itself for code that reads error.message', () => {
    const error = buildResponseError(response(404), null)
    expect(error.message).toBe('The requested resource was not found.')
    expect(error.isStatusFallback).toBe(true)
  })

  it('never replaces a message the server wrote, even though the synthesized code is HTTP_<status>', () => {
    void i18n.changeLanguage('fr')
    const error = buildResponseError(response(400), { error: 'Username is required' })
    expect(error.code).toBe('HTTP_400')
    expect(error.isStatusFallback).toBe(false)
    expect(getUserErrorMessage(error, 'fallback')).toBe('Username is required')
  })

  it('still lets a server-sent registered code win over the stock text', () => {
    void i18n.changeLanguage('fr')
    const error = buildResponseError(response(429), { code: 'RATE_LIMIT_LOGIN' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Trop de tentatives de connexion. Réessayez plus tard.')
  })

  it('leaves an ApiError somebody built by hand alone (no flag, no synthesized translation)', () => {
    void i18n.changeLanguage('fr')
    const error = new ApiError('The requested resource was not found.', { status: 404, code: 'HTTP_404' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('The requested resource was not found.')
  })
})

describe('getUserErrorMessage: the Retry-After suffix is translated', () => {
  it('reads the same as before in English', () => {
    const error = buildResponseError(response(429, { 'retry-after': '42' }), { error: 'Too many requests, please try again later.' })
    expect(error.message).toBe('Too many requests, please try again later. Try again in 42 seconds.')
    expect(getUserErrorMessage(error, 'fallback')).toBe(error.message)
  })

  it('swaps the English suffix for a translated one after a server-written message', () => {
    void i18n.changeLanguage('fr')
    const error = buildResponseError(response(429, { 'retry-after': '42' }), { error: 'Too many requests, please try again later.' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Too many requests, please try again later. Réessayez dans 42 secondes.')
  })

  it('translates both the stock text and the suffix when the server sent no message', () => {
    void i18n.changeLanguage('de')
    const error = buildResponseError(response(429, { 'retry-after': '5' }), null)
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      'Es wurden zu viele Anfragen gesendet. Warte einen Moment und versuche es erneut. Versuche es in 5 Sekunden erneut.',
    )
  })

  it('counts whole minutes past a minute and says "a moment" for zero', () => {
    void i18n.changeLanguage('es')
    const minutes = buildResponseError(response(429, { 'retry-after': '125' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(minutes, 'fallback')).toBe('Slow down. Inténtalo de nuevo en 3 minutos.')
    const moment = buildResponseError(response(429, { 'retry-after': '0' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(moment, 'fallback')).toBe('Slow down. Inténtalo de nuevo en un momento.')
  })

  it('uses the singular form for one second and one minute', () => {
    void i18n.changeLanguage('en')
    const second = buildResponseError(response(429, { 'retry-after': '1' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(second, 'fallback')).toBe('Slow down. Try again in 1 second.')
    const minute = buildResponseError(response(429, { 'retry-after': '60' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(minute, 'fallback')).toBe('Slow down. Try again in 1 minute.')
  })

  it('picks the right plural form per language (Ukrainian, Arabic)', () => {
    void i18n.changeLanguage('uk')
    const one = buildResponseError(response(429, { 'retry-after': '21' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(one, 'fallback')).toBe('Slow down. Спробуйте ще раз за 21 секунду.')
    const few = buildResponseError(response(429, { 'retry-after': '3' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(few, 'fallback')).toBe('Slow down. Спробуйте ще раз за 3 секунди.')
    const many = buildResponseError(response(429, { 'retry-after': '5' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(many, 'fallback')).toBe('Slow down. Спробуйте ще раз за 5 секунд.')

    void i18n.changeLanguage('ar')
    const arFew = buildResponseError(response(429, { 'retry-after': '3' }), { error: 'Slow down.' })
    expect(getUserErrorMessage(arFew, 'fallback')).toContain('ثوانٍ')
  })

  it('wraps an uncoded 5xx first, then adds the wait', () => {
    void i18n.changeLanguage('fr')
    const error = buildResponseError(response(503, { 'retry-after': '30' }), { error: 'Server busy' })
    expect(getUserErrorMessage(error, 'fallback')).toBe(
      "Server busy. Ce n'était pas attendu — si cela persiste, téléchargez un pack de support afin qu'il puisse être examiné. Réessayez dans 30 secondes.",
    )
  })

  it('leaves a registered translation exactly as it was (it never carried the wait)', () => {
    void i18n.changeLanguage('fr')
    const error = buildResponseError(response(429, { 'retry-after': '30' }), { error: 'Too many login attempts.', code: 'RATE_LIMIT_LOGIN' })
    expect(getUserErrorMessage(error, 'fallback')).toBe('Trop de tentatives de connexion. Réessayez plus tard.')
  })
})
