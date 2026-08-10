import { ApiError } from './api'

export function getUserErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = error.message?.trim()
    if (message && message.toLowerCase() !== 'unknown error') {
      return message
    }
    return fallback
  }

  if (error instanceof Error) {
    const message = error.message?.trim()
    if (message && message.toLowerCase() !== 'unknown error') {
      return message
    }
    return fallback
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const candidate = (error as { message?: unknown }).message
    if (typeof candidate === 'string' && candidate.trim() && candidate.toLowerCase() !== 'unknown error') {
      return candidate.trim()
    }
  }

  return fallback
}

export function getRecoveryUrl(error: unknown): string | null {
  const payload = error instanceof ApiError && error.data && typeof error.data === 'object'
    ? error.data as { fixUrl?: unknown }
    : null
  if (typeof payload?.fixUrl === 'string' && payload.fixUrl.startsWith('/')) {
    return payload.fixUrl
  }

  const message = error instanceof Error ? error.message : String(error || '')
  if (/rcon|connection refused|authentication failed/i.test(message)) return '/settings?tab=connection'
  if (/panelbridge|bridge not running|bridge not configured/i.test(message)) return '/settings?tab=bridge'
  if (/no active server|no server configured/i.test(message)) return '/servers'
  return null
}
