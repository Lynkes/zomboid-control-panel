import { describe, it, expect } from 'vitest'
import { isValidServerName } from '../Servers'

// bug-hunt-2026-09-18 (round 12, client-vs-server validation sweep): the
// Edit Server dialog's serverName field had no character-set check at all
// (only maxLength={64}) even though server/routes/servers.js rejects
// anything not matching SERVER_NAME_REGEX with a generic 400 "Invalid
// server name" -- a leading/trailing space, a slash, or punctuation sailed
// past the disabled-button gate and only failed after the round trip. This
// mirrors that exact regex, so any future drift between the two shows up
// here rather than as a live 400 an operator hits blind.
describe('Servers -- isValidServerName', () => {
  it('accepts plain alphanumeric names, matching the server-side rule', () => {
    expect(isValidServerName('servertest')).toBe(true)
    expect(isValidServerName('Server123')).toBe(true)
    expect(isValidServerName('a')).toBe(true)
    expect(isValidServerName('1')).toBe(true)
    expect(isValidServerName('_')).toBe(true)
    expect(isValidServerName('-')).toBe(true)
  })

  it('accepts hyphens, underscores, and interior spaces', () => {
    expect(isValidServerName('my-server_01')).toBe(true)
    expect(isValidServerName('My Server')).toBe(true)
    expect(isValidServerName('a b c')).toBe(true)
  })

  it('rejects leading or trailing spaces', () => {
    expect(isValidServerName(' servertest')).toBe(false)
    expect(isValidServerName('servertest ')).toBe(false)
    expect(isValidServerName(' ')).toBe(false)
  })

  it('rejects characters the server treats as path-unsafe', () => {
    expect(isValidServerName('server/name')).toBe(false)
    expect(isValidServerName('server\\name')).toBe(false)
    expect(isValidServerName('server.name')).toBe(false)
    expect(isValidServerName('server!name')).toBe(false)
    expect(isValidServerName('../etc')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidServerName('')).toBe(false)
  })
})
