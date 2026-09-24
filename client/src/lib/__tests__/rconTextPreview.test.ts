import { describe, it, expect } from 'vitest'
import { previewBanReason, banReasonWillBeAltered } from '../rconTextPreview'

// bug-hunt-2026-09-18 (round 16, silently-altered player-action text sweep):
// literal client mirror of server/services/rcon.js's foldToRconAscii() +
// sanitizeForBanReason() (shared by kickPlayer() and banPlayer()). These
// tests assert the mirror's actual output for a range of inputs -- if the
// two ever drift, server/tests/rcon.test.js's own
// 'sanitizeForBanReason / banPlayer (shared ASCII folding)' suite is the
// other half that must still agree with these exact expectations.
describe('rconTextPreview -- previewBanReason', () => {
  it('leaves plain ASCII text within the whitelist unchanged', () => {
    expect(previewBanReason('Griefing the base')).toBe('Griefing the base')
    expect(previewBanReason("Don't grief, please!")).toBe("Don't grief, please!")
  })

  it('folds curly quotes, dashes, and ellipsis to plain ASCII', () => {
    expect(previewBanReason('griefing ‘the base’')).toBe("griefing 'the base'")
    expect(previewBanReason('rule 3 – no griefing')).toBe('rule 3 - no griefing')
    expect(previewBanReason('final warning…')).toBe('final warning...')
  })

  it('transliterates known accented Latin letters instead of dropping them (parens are stripped separately -- not in the ban-reason whitelist)', () => {
    expect(previewBanReason('Cheaté (used mods)')).toBe('Cheate used mods')
  })

  it('strips quotes, backslashes, and anything outside the ban-reason whitelist', () => {
    // Whitespace collapsing (foldToRconAscii's own `\s+` -> ' ') happens
    // BEFORE the whitelist strip below removes the backslash, so the two
    // spaces that were on either side of it are not re-collapsed afterward
    // -- this is the server's actual, real behavior (verified against a
    // literal copy of sanitizeForBanReason() run standalone), not a guess.
    expect(previewBanReason('griefing "the base" \\ 100% <script>')).toBe('griefing the base  100 script')
  })

  it('drops non-Latin scripts and emoji entirely (nothing to transliterate)', () => {
    expect(previewBanReason('griefing \u{1F600}')).toBe('griefing')
    expect(previewBanReason('бан')).toBe('') // Cyrillic "ban"
  })

  it('truncates to 100 characters, matching the server-side cap', () => {
    const long = 'a'.repeat(150)
    expect(previewBanReason(long)).toHaveLength(100)
  })

  it('returns an empty string for empty/falsy input', () => {
    expect(previewBanReason('')).toBe('')
  })
})

describe('rconTextPreview -- banReasonWillBeAltered', () => {
  it('is false for text that survives folding unchanged', () => {
    expect(banReasonWillBeAltered('Griefing the base')).toBe(false)
  })

  it('is false for trivial whitespace differences alone (not worth alarming the operator over)', () => {
    expect(banReasonWillBeAltered('  Griefing the base  ')).toBe(false)
    expect(banReasonWillBeAltered('Griefing   the base')).toBe(false)
  })

  it('is true when a character will actually be stripped or transliterated', () => {
    expect(banReasonWillBeAltered('griefing "the base"')).toBe(true)
    expect(banReasonWillBeAltered('Cheaté')).toBe(true)
  })

  it('is true when the text would be truncated', () => {
    expect(banReasonWillBeAltered('a'.repeat(150))).toBe(true)
  })

  it('is false for empty input', () => {
    expect(banReasonWillBeAltered('')).toBe(false)
  })
})
