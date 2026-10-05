// SECURITY (2026-10-05, A1): the trusted-device token the server hands back
// after a successful sign-in, first-run setup or session refresh
// (server/services/auth.js, issueDeviceToken()). Sent with later sign-ins to
// the same account, it makes the server count this browser's failed
// attempts on their own, so a stranger who fills the server's per-address
// table, or who shares this browser's address (a proxy or tunnel without
// TRUST_PROXY), can't get this browser refused.
//
// Kept per username in localStorage and sent as a JSON field, never as a
// cookie: a cross-site page can't attach it to a forged sign-in and spend
// this browser's attempts. It is not a credential -- it grants nothing but
// this browser's own count of failed attempts, and a password change
// retires it -- so localStorage is an acceptable home for it.

const STORAGE_KEY = 'pz-login-trusted-devices'
// Accounts remembered per browser; the oldest drop off first.
const MAX_ACCOUNTS = 10
const MAX_TOKEN_LENGTH = 1024

type StoredDevice = { token: string; savedAt: number }

// Prefixed so no username ("__proto__" is a valid one) can collide with an
// Object.prototype key.
function entryKey(username: string): string {
  return `u:${username.trim().toLowerCase()}`
}

function readAll(): Record<string, StoredDevice> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries: Record<string, StoredDevice> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.startsWith('u:') || !value || typeof value !== 'object') continue
      const { token, savedAt } = value as Partial<StoredDevice>
      if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) continue
      entries[key] = { token, savedAt: Number(savedAt) || 0 }
    }
    return entries
  } catch {
    return {}
  }
}

export function getTrustedDeviceToken(username: string): string | undefined {
  if (typeof username !== 'string' || !username.trim()) return undefined
  return readAll()[entryKey(username)]?.token
}

export function rememberTrustedDeviceToken(username: unknown, token: unknown): void {
  if (typeof username !== 'string' || !username.trim()) return
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return
  try {
    const entries = readAll()
    entries[entryKey(username)] = { token, savedAt: Date.now() }
    const kept = Object.entries(entries)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_ACCOUNTS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage unavailable (private mode, blocked site data): sign-ins from
    // this browser are just counted by address, as before.
  }
}
