import { describe, expect, it } from 'vitest'
import { extractSaveWarnings } from '../saveWarnings'

describe('extractSaveWarnings', () => {
  it('returns the warnings the server attached to a successful save', () => {
    expect(
      extractSaveWarnings({
        success: true,
        message: 'Settings saved',
        warnings: ['Server manager failed to reload — restart may be required', 'RCON service failed to reload — reconnect may be required'],
      }),
    ).toEqual([
      'Server manager failed to reload — restart may be required',
      'RCON service failed to reload — reconnect may be required',
    ])
  })

  it('is empty for a clean save, whatever else the body holds', () => {
    expect(extractSaveWarnings({ success: true, message: 'Settings saved' })).toEqual([])
    expect(extractSaveWarnings({ success: true, warnings: [] })).toEqual([])
    expect(extractSaveWarnings(undefined)).toEqual([])
    expect(extractSaveWarnings(null)).toEqual([])
    expect(extractSaveWarnings('ok')).toEqual([])
  })

  it('drops anything that is not a non-empty string', () => {
    expect(extractSaveWarnings({ warnings: ['  keep me  ', '', '   ', 7, null, { message: 'x' }] })).toEqual(['keep me'])
    expect(extractSaveWarnings({ warnings: 'not a list' })).toEqual([])
  })
})
