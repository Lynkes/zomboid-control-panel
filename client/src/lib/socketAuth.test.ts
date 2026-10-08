import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tryRefreshToken = vi.fn()
vi.mock('./api', () => ({ tryRefreshToken: (...args: unknown[]) => tryRefreshToken(...args) }))

const { createSocketAuthProvider } = await import('./socketAuth')

function makeToken(expiresInSeconds: number): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = { exp: Math.floor(Date.now() / 1000) + expiresInSeconds }
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.sig`
}

// jsdom's window.location.reload is non-configurable; redefining `location`
// itself is the workaround lib/__tests__/apiRetry401Then5xx.test.ts uses.
const originalLocation = window.location
let reloadSpy: ReturnType<typeof vi.fn>

describe('createSocketAuthProvider', () => {
  beforeEach(() => {
    tryRefreshToken.mockReset()
    reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('does not call tryRefreshToken and hands back the current token when it is still comfortably valid', async () => {
    const token = makeToken(15 * 60)
    const getToken = vi.fn(() => token)
    const callback = vi.fn()

    createSocketAuthProvider(getToken, true)(callback)
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith({ token })
  })

  it('refreshes first when the token is expired, then hands back the refreshed token', async () => {
    const staleToken = makeToken(-60)
    const freshToken = makeToken(15 * 60)
    let currentToken = staleToken
    tryRefreshToken.mockImplementation(async () => {
      currentToken = freshToken
      return true
    })
    const getToken = vi.fn(() => currentToken)
    const callback = vi.fn()

    createSocketAuthProvider(getToken, true)(callback)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ token: freshToken })
  })

  it('refreshes first when the token is within the near-expiry buffer', async () => {
    const nearExpiryToken = makeToken(30) // inside the 60s buffer
    tryRefreshToken.mockResolvedValue(true)
    const getToken = vi.fn(() => nearExpiryToken)
    const callback = vi.fn()

    createSocketAuthProvider(getToken, true)(callback)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
  })

  // The server closes the socket at the token's exp by ITS clock; a browser
  // clock running behind still sees minutes left and would resend it.
  it('refreshes a token this clock still thinks is valid when mustRefresh says the server expired it', async () => {
    const staleToken = makeToken(10 * 60)
    const freshToken = makeToken(15 * 60)
    let currentToken = staleToken
    tryRefreshToken.mockImplementation(async () => {
      currentToken = freshToken
      return true
    })
    const callback = vi.fn()

    createSocketAuthProvider(() => currentToken, true, () => true)(callback)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ token: freshToken })
  })

  it('with logins off, hands back an empty payload without ever calling refresh', async () => {
    const getToken = vi.fn(() => null)
    const callback = vi.fn()

    createSocketAuthProvider(getToken, false)(callback)
    await Promise.resolve()
    await Promise.resolve()

    expect(tryRefreshToken).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith({})
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  // Audit #20: a token dropped by an earlier failed refresh used to leave a
  // socket the server refused forever, because a null token never refreshed.
  it('signed in with no token, refreshes first and hands back the new token', async () => {
    const freshToken = makeToken(15 * 60)
    let currentToken: string | null = null
    tryRefreshToken.mockImplementation(async () => {
      currentToken = freshToken
      return true
    })
    const callback = vi.fn()

    createSocketAuthProvider(() => currentToken, true)(callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ token: freshToken })
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('signed in with no token and a refresh that fails, reloads instead of connecting without one', async () => {
    tryRefreshToken.mockResolvedValue(false)
    const callback = vi.fn()

    createSocketAuthProvider(() => null, true)(callback)
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1))

    expect(tryRefreshToken).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
  })

  it('reloads when the refresh of an expired token is refused and leaves no token behind', async () => {
    const staleToken = makeToken(-60)
    let currentToken: string | null = staleToken
    tryRefreshToken.mockImplementation(async () => {
      currentToken = null // the panel refused the cookie -- token store cleared
      return false
    })
    const callback = vi.fn()

    createSocketAuthProvider(() => currentToken, true)(callback)
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1))

    expect(callback).not.toHaveBeenCalled()
  })

  it('keeps going with the token it has when a refresh fails but leaves it in place (a 503)', async () => {
    const nearExpiryToken = makeToken(30)
    tryRefreshToken.mockResolvedValue(false)
    const callback = vi.fn()

    createSocketAuthProvider(() => nearExpiryToken, true)(callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    expect(callback).toHaveBeenCalledWith({ token: nearExpiryToken })
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})
