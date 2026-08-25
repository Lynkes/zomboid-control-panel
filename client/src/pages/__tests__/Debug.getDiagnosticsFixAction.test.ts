import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { getDiagnosticsFixAction } from '../Debug'

// Minimal stand-in for i18next's t() -- these tests only assert on the
// boolean openServerConfig/openMods decisions, never on translated text.
const t = ((key: string) => key) as unknown as TFunction

function fallbackCheck(overrides: Partial<{
  id: string
  status: 'ok' | 'warn' | 'fail' | 'info' | 'skip'
  category: string
  hint: string
}>) {
  return {
    id: 'some.unregistered.check',
    label: 'Some check',
    status: 'fail' as const,
    severity: 'critical' as const,
    message: 'Some message.',
    category: 'services',
    ...overrides,
  }
}

describe('getDiagnosticsFixAction fallback branch (uncovered check ids)', () => {
  it('opens server config when the hint contains the literal server.ini token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Edit server.ini to fix this.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(true)
  })

  it('does NOT open server config for translated prose that would have matched the old English phrase', () => {
    // Regression case: this is what a German-translated hint for the same
    // underlying concept looks like. The fallback must never decide UI
    // behaviour from prose, translated or not -- only from the literal
    // do-not-translate INI token, which this string does not contain.
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Öffne die Serverkonfiguration, um dies zu beheben.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
  })

  it('does NOT open server config for the English prose phrase alone, without the literal token', () => {
    // Same check in English: "server config" prose alone no longer
    // triggers the button either -- the fix removes the phrase entirely
    // rather than special-casing English.
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Open server config to fix this.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
  })

  it('opens mods when the hint contains the literal Mods= token', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Remove the entry from Mods= and retry.' }),
      t,
    )
    expect(action?.openMods).toBe(true)
  })

  it('is case-insensitive for the literal tokens (hint is lowercased before matching)', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Check SERVER.INI for a stray entry.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(true)
  })

  it('returns neither flag when the hint matches nothing', () => {
    const action = getDiagnosticsFixAction(
      fallbackCheck({ hint: 'Restart the panel and try again.' }),
      t,
    )
    expect(action?.openServerConfig).toBe(false)
    expect(action?.openMods).toBe(false)
  })

  it('returns null for a passing or skipped check regardless of hint content', () => {
    expect(
      getDiagnosticsFixAction(
        fallbackCheck({ status: 'ok', hint: 'server.ini' }),
        t,
      ),
    ).toBeNull()
    expect(
      getDiagnosticsFixAction(
        fallbackCheck({ status: 'skip', hint: 'server.ini' }),
        t,
      ),
    ).toBeNull()
  })

  it('returns null for an info-status check with no explicit switch case', () => {
    expect(
      getDiagnosticsFixAction(fallbackCheck({ status: 'info' }), t),
    ).toBeNull()
  })
})
