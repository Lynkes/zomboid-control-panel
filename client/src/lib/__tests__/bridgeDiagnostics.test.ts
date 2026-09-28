import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { bridgeDiagnosticParams } from '../bridgeDiagnostics'

// Review of the merge: bridgeSilentSinceStart (and statusFileStale before
// it) filled {{age}} with the server's English compact units inside
// translated sentences -- pt-BR "O servidor de jogo foi iniciado há 12m",
// where a bare m reads as metres, beside the Dashboard's "ativo há 12 min".
describe('bridgeDiagnosticParams', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it("re-words the age in the UI language's units when the server sends it as a number", async () => {
    await i18n.changeLanguage('pt-BR')
    const params = bridgeDiagnosticParams({ age: '12m', ageSeconds: 12 * 60 + 30 })
    expect(params.age).toBe('12 min')
    expect(
      i18n.t('bridge.diagnostics.bridgeSilentSinceStart', { ns: 'settings', ...params, defaultValue: 'x' }),
    ).toMatch(/há 12 min\b/)
  })

  it("keeps the server's own age from a server that sends no number", () => {
    expect(bridgeDiagnosticParams({ age: '12m' })).toEqual({ age: '12m' })
    expect(bridgeDiagnosticParams(undefined)).toEqual({})
    expect(bridgeDiagnosticParams({ filename: 'status.json', error: 'EACCES' })).toEqual({
      filename: 'status.json', error: 'EACCES',
    })
  })
})
