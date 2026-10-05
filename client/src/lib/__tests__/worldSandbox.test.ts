import { describe, expect, it } from 'vitest'
import { liveWorldSandboxOutcome } from '../worldSandbox'

// #197: the server reports worldSandboxSnapshot { path, refreshed } after a
// live sandbox change only for a world with a map_sand.bin.
describe('liveWorldSandboxOutcome', () => {
  it('is null for a world without the file, or an answer without the field', () => {
    expect(liveWorldSandboxOutcome({})).toBeNull()
    expect(liveWorldSandboxOutcome({ worldSandboxSnapshot: null })).toBeNull()
    expect(liveWorldSandboxOutcome(null)).toBeNull()
    expect(liveWorldSandboxOutcome(undefined)).toBeNull()
  })

  it("is 'kept' only for an explicit refreshed: true", () => {
    expect(liveWorldSandboxOutcome({ worldSandboxSnapshot: { refreshed: true } })).toBe('kept')
  })

  it("reads anything else as 'undone': the next start loads the file without the change", () => {
    expect(liveWorldSandboxOutcome({ worldSandboxSnapshot: { refreshed: false } })).toBe('undone')
    expect(liveWorldSandboxOutcome({ worldSandboxSnapshot: { refreshed: 'true' } })).toBe('undone')
    expect(liveWorldSandboxOutcome({ worldSandboxSnapshot: {} })).toBe('undone')
  })
})
