import { ApiError } from './api'
import { getUserErrorMessage } from './errorMessage'

// The English wording of the three texts below is only the fallback: each
// error carries a code and errors.json has the translation, which
// getUserErrorMessage() picks at display time (Login.tsx, Setup.tsx).
const CORS_LOGIN_MESSAGE = 'Connection blocked by browser origin policy. For first-time reverse-proxy setup, set CORS_ORIGINS to this URL in the panel environment and restart it. Otherwise open the panel from a local/LAN address; after setup, manage origins in Settings > Remote Access.'

export const LOGIN_FAILED_MESSAGE = "We couldn't sign you in. Check your username and password and try again."

export const SETUP_FAILED_MESSAGE = "We couldn't create the admin account. Try again."

// Client-side codes (errors.json keys; no server route sends them).
export const LOGIN_FAILED_CODE = 'LOGIN_FAILED'
export const LOGIN_CORS_BLOCKED_CODE = 'LOGIN_CORS_BLOCKED'
export const SETUP_FAILED_CODE = 'SETUP_FAILED'

// What AuthContext's login() throws for a failed attempt. Lives here, with no
// component state in sight, so its 5xx-vs-auth-failure branch can be unit
// tested directly (see __tests__/AuthContext.test.ts).
//
// A coded ApiError whose message is the English fallback, so the display
// layer can translate it; a transport or server failure worth its own text
// is passed through untouched (code, status, Retry-After and all).
export function toLoginError(error: unknown): ApiError {
  if (error instanceof TypeError) {
    return new ApiError(CORS_LOGIN_MESSAGE, { code: LOGIN_CORS_BLOCKED_CODE })
  }
  if (error instanceof Error && /cors|origin policy|failed to fetch/i.test(error.message)) {
    return new ApiError(CORS_LOGIN_MESSAGE, { code: LOGIN_CORS_BLOCKED_CODE })
  }
  // 2026-09-08 (auth-transport-parity): login() now goes through
  // lib/api.ts's shared apiFetch/fetchWithRetry instead of a raw fetch() --
  // that path already converts a browser-level CORS rejection (a TypeError,
  // usually "Failed to fetch") into an ApiError coded NETWORK_ERROR with a
  // different message ("Unable to reach the server...") before it ever
  // reaches this function, so neither check above can match it anymore. The
  // failure this branch exists to catch is unchanged; only its shape is.
  if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
    return new ApiError(CORS_LOGIN_MESSAGE, { code: LOGIN_CORS_BLOCKED_CODE })
  }
  // A request that timed out says nothing about the credentials either, and
  // "check your username and password" sends the user the wrong way; the
  // transport's own (translated) TIMEOUT text is the honest one.
  if (error instanceof ApiError && error.code === 'TIMEOUT') {
    return error
  }
  // 2026-08-26: the enumeration ruling (revealing WHY authentication failed
  // -- wrong username vs. wrong password vs. locked account -- is an
  // account-enumeration oracle) only applies to an actual auth failure
  // (4xx). It says nothing about a genuine server error, which reveals no
  // information about the account either way -- collapsing a real 500 into
  // the identical "check your password" text was never required by that
  // ruling, just an accidental side effect of throwing a plain Error that
  // discarded the response status. A coded 5xx is preferred to the generic
  // fallback text here too, via getUserErrorMessage's normal precedence.
  if (error instanceof ApiError && typeof error.status === 'number' && error.status >= 500) {
    return error
  }
  // bug-hunt-2026-09-07 (client silent-failure lane, error-code coverage
  // pass): a 429 from loginLimiter (server/routes/auth.js) used to fall
  // through to the generic text right alongside an actual wrong-password 401
  // -- the two are handled by the same generic branch below, but that
  // branch's text ("check your username and password") is actively wrong for
  // a rate-limited attempt, not merely unspecific. The enumeration ruling
  // this function exists to enforce is about NOT revealing why an auth
  // attempt failed; RATE_LIMIT_LOGIN doesn't touch that at all -- "too many
  // attempts" is identical regardless of whether the account exists, so it
  // can safely use its own already-registered, already-translated text
  // (errors.json) instead of being swallowed into the credentials hint.
  if (error instanceof ApiError && error.status === 429) {
    return error
  }
  return new ApiError(LOGIN_FAILED_MESSAGE, {
    status: error instanceof ApiError ? error.status : undefined,
    code: LOGIN_FAILED_CODE,
  })
}

// The same error as translated text, for callers that want a string.
export function getLoginErrorMessage(error: unknown): string {
  return getUserErrorMessage(toLoginError(error), LOGIN_FAILED_MESSAGE)
}
