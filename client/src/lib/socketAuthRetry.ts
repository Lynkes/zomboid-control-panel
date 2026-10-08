// What server/index.js's io.use answers when it refuses the token itself.
const SOCKET_AUTH_REFUSALS = new Set(['Invalid or expired token', 'Authentication required'])

export const SOCKET_AUTH_RETRIES = 3
export const SOCKET_AUTH_RETRY_STEP_MS = 2000

export function isSocketAuthRefusal(message: unknown): boolean {
  return typeof message === 'string' && SOCKET_AUTH_REFUSALS.has(message)
}

/**
 * socket.io never retries a handshake the server refused. When the refusal
 * was for the token, it is usually worth another try: the refresh before
 * it failed in passing (a 429, a 5xx, a timeout, a lost race between tabs)
 * and kept the expired token, or the account was signed out elsewhere. The
 * socket's auth provider refreshes before each try, so one that works
 * reconnects and one the panel refuses ends in the sign-in screen.
 *
 * `retry` is called 2, 4 and 6 s after the first three refusals in a row;
 * schedule() returns false after that, so the caller shows the error and
 * Retry. reset() after a connect, dispose() when the socket goes away.
 */
export function createSocketAuthRetry(retry: () => void) {
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    schedule(): boolean {
      if (attempts >= SOCKET_AUTH_RETRIES) return false
      attempts += 1
      cancel()
      timer = setTimeout(() => {
        timer = null
        retry()
      }, SOCKET_AUTH_RETRY_STEP_MS * attempts)
      return true
    },
    reset() {
      attempts = 0
      cancel()
    },
    dispose: cancel,
  }
}
