// Reads claims out of a JWT WITHOUT verifying its signature -- this is only
// ever used on OUR OWN cached access token: to decide whether it's worth
// sending on a socket (re)connect or worth calling /api/auth/refresh first,
// and to notice when a refresh hands back a different account. The server
// remains the only real authority on whether a token is actually valid;
// these checks never gate access to anything by themselves. No JWT library:
// reading one claim out of a token we already hold doesn't need one.
export function isTokenExpiredOrNearExpiry(token: string, bufferMs = 60_000): boolean {
  const exp = decodeJwtPayload(token)?.exp
  if (typeof exp !== 'number') return true // unreadable/malformed -- treat as needing a refresh
  return exp * 1000 - bufferMs <= Date.now()
}

// The account a token was issued to (server/services/auth.js's
// generateAccessToken puts it in `userId`), or null when there is no token
// or it can't be read.
export function decodeJwtUserId(token: string | null): string | null {
  if (!token) return null
  const userId = decodeJwtPayload(token)?.userId
  return typeof userId === 'string' && userId ? userId : null
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payloadSegment = token.split('.')[1]
    if (!payloadSegment) return null
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const payload: unknown = JSON.parse(atob(padded))
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}
