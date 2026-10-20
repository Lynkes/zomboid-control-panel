import { describe, it, expect } from 'vitest'
import { resolveServerConfigDeepLink } from '../ServerConfig'

// The section headers (and their wrap fix) are SectionCard's now
// (components/ui/section-card.tsx); this file keeps the deep-link parser's
// cases.
describe('ServerConfig deep links', () => {
  it('opens the INI tab with a bounded search term', () => {
    expect(resolveServerConfigDeepLink(new URLSearchParams('tab=ini&search=%20Mods%20&unresolved=ArcadiaQOLSafehouse_B42')))
      .toEqual({
        tab: 'ini',
        search: 'Mods',
        unresolved: ['ArcadiaQOLSafehouse_B42'],
        unresolvedTriage: new Map(),
      })
  })

  it('falls back to the INI tab for unknown tab values', () => {
    expect(resolveServerConfigDeepLink(new URLSearchParams('tab=unknown')))
      .toEqual({ tab: 'ini', search: '', unresolved: [], unresolvedTriage: new Map() })
  })
})
