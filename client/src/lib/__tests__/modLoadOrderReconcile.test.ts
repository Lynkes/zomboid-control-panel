import { describe, expect, it } from 'vitest'
import { reconcileLoadOrder, sameLoadOrderEntries } from '../modLoadOrder'

// The Load order list used to be replaced by the server's Mods= on every
// reload of the page's data (an update check, a restart event, a mod removed
// or a dependency added elsewhere on the page), throwing away unsaved moves.

describe('reconcileLoadOrder', () => {
  it('takes the server list when there are no unsaved moves', () => {
    expect(reconcileLoadOrder(['a', 'b'], ['a', 'b'], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c'])
  })

  it('keeps unsaved moves when the server list did not change', () => {
    expect(reconcileLoadOrder(['c', 'a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })

  it('keeps unsaved moves and adds what the server gained after the entry it follows there', () => {
    // local: c moved to the top; the server gained x (after b) and y (first).
    expect(reconcileLoadOrder(['c', 'a', 'b'], ['a', 'b', 'c'], ['y', 'a', 'b', 'x', 'c'])).toEqual(['y', 'c', 'a', 'b', 'x'])
  })

  it('puts what the server appended at the end of the unsaved order', () => {
    // b moved to the top; the server appended x and y (a mod enabled elsewhere).
    expect(reconcileLoadOrder(['b', 'a'], ['a', 'b'], ['a', 'b', 'x', 'y'])).toEqual(['b', 'a', 'x', 'y'])
  })

  it('drops what the server no longer has and keeps the rest of the unsaved order', () => {
    expect(reconcileLoadOrder(['c', 'b', 'a'], ['a', 'b', 'c'], ['a', 'c'])).toEqual(['c', 'a'])
  })

  it('keeps a repeated entry only as many times as the server lists it', () => {
    expect(reconcileLoadOrder(['b', 'a', 'a'], ['a', 'a', 'b'], ['a', 'b'])).toEqual(['b', 'a'])
  })
})

describe('sameLoadOrderEntries', () => {
  it('compares the entries, not their order', () => {
    expect(sameLoadOrderEntries(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true)
    expect(sameLoadOrderEntries(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
    expect(sameLoadOrderEntries(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(false)
  })
})
