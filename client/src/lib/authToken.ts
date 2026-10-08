import { decodeJwtUserId } from './jwt'

let accessToken: string | null = null
// The account this tab is signed in as, kept apart from the token: a failed
// refresh clears the token, and a later refresh must still refuse to hand
// this tab another account (audit #15, review 1-02). Reset only by a reload,
// or by forgetSessionUser() when the tab shows the sign-in screen.
let sessionUserId: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null) {
  accessToken = token
  const userId = decodeJwtUserId(token)
  if (userId) sessionUserId = userId
}

export function clearAccessToken() {
  accessToken = null
}

export function getSessionUserId(): string | null {
  return sessionUserId
}

export function forgetSessionUser() {
  sessionUserId = null
}
