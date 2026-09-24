import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRequestGuard } from '../useRequestGuard'

describe('useRequestGuard', () => {
  it('marks the newest call current and every older call stale once a newer one has started', () => {
    const { result } = renderHook(() => useRequestGuard())

    let idA = -1
    let idB = -1
    act(() => {
      idA = result.current.next()
      idB = result.current.next()
    })

    expect(idA).not.toBe(idB)
    expect(result.current.isStale(idA)).toBe(true)
    expect(result.current.isStale(idB)).toBe(false)
  })

  it('a single in-flight call is never stale relative to itself', () => {
    const { result } = renderHook(() => useRequestGuard())

    let id = -1
    act(() => {
      id = result.current.next()
    })

    expect(result.current.isStale(id)).toBe(false)
  })
})
