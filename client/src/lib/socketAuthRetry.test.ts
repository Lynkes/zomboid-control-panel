import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocketAuthRetry, isSocketAuthRefusal } from './socketAuthRetry'

// Integration review 2026-10-08: the panel closes every socket when its
// token expires, and a passing refresh failure before the reconnect kept the
// expired token. The server refused that handshake, socket.io never retried
// it, and the live feed stayed dead until someone found Retry.

afterEach(() => {
  vi.useRealTimers()
})

describe('socket auth retry', () => {
  it("knows the server's refusals for the token, and nothing else", () => {
    expect(isSocketAuthRefusal('Invalid or expired token')).toBe(true)
    expect(isSocketAuthRefusal('Authentication required')).toBe(true)
    expect(isSocketAuthRefusal('First-run setup required')).toBe(false)
    expect(isSocketAuthRefusal('xhr poll error')).toBe(false)
    expect(isSocketAuthRefusal(undefined)).toBe(false)
  })

  it('retries three times, 2, 4 and 6 s apart, then leaves it to Retry', async () => {
    vi.useFakeTimers()
    const reconnect = vi.fn()
    const retry = createSocketAuthRetry(reconnect)

    expect(retry.schedule()).toBe(true)
    await vi.advanceTimersByTimeAsync(1999)
    expect(reconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reconnect).toHaveBeenCalledTimes(1)

    expect(retry.schedule()).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(reconnect).toHaveBeenCalledTimes(2)

    expect(retry.schedule()).toBe(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(reconnect).toHaveBeenCalledTimes(3)

    expect(retry.schedule()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reconnect).toHaveBeenCalledTimes(3)
  })

  it('a connect starts the count afresh and cancels a pending try', async () => {
    vi.useFakeTimers()
    const reconnect = vi.fn()
    const retry = createSocketAuthRetry(reconnect)
    retry.schedule()
    retry.schedule()

    retry.reset()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reconnect).not.toHaveBeenCalled()

    expect(retry.schedule()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('nothing fires after dispose', async () => {
    vi.useFakeTimers()
    const reconnect = vi.fn()
    const retry = createSocketAuthRetry(reconnect)
    retry.schedule()

    retry.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reconnect).not.toHaveBeenCalled()
  })
})
