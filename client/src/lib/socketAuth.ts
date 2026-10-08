import { tryRefreshToken } from './api'
import { isTokenExpiredOrNearExpiry } from './jwt'

/**
 * Builds a socket.io `auth` provider function. Passing `auth` as a
 * FUNCTION (not a plain object) is what lets this refresh the access
 * token first when it's stale, instead of racing a synchronous read
 * against however long a refresh call takes -- socket.io calls the
 * returned function itself, with a callback, immediately before sending
 * the CONNECT packet on EVERY connection attempt (the initial connect,
 * every automatic reconnect, and any manual .connect() call), so there is
 * exactly one place this logic lives, not one copy per trigger.
 *
 * Reads OUR OWN token purely to decide whether calling /api/auth/refresh
 * first is worth it; the server remains the only real authority on
 * whether the token it's handed is actually valid.
 *
 * `signedIn` is false only when logins are off, where no token is expected.
 * Otherwise a missing token is refreshed too (audit #20): without that, a
 * token dropped by an earlier failed refresh left a socket the server
 * refused on every attempt while the tab still looked signed in. When the
 * refresh leaves no token, the page reloads, so checkAuth shows the
 * sign-in screen or signs back in.
 *
 * `mustRefresh` overrides the expiry guess when the server has already said
 * the token expired (audit #11): a browser clock running behind the
 * server's would otherwise keep sending it.
 */
export function createSocketAuthProvider(
  getToken: () => string | null,
  signedIn: boolean,
  mustRefresh: () => boolean = () => false,
) {
  return (callback: (data: Record<string, string>) => void) => {
    void (async () => {
      let token = getToken()
      if (signedIn && (!token || mustRefresh() || isTokenExpiredOrNearExpiry(token))) {
        const refreshed = await tryRefreshToken()
        token = getToken()
        if (!refreshed && !token) {
          window.location.reload()
          return
        }
      }
      callback(token ? { token } : {})
    })()
  }
}
