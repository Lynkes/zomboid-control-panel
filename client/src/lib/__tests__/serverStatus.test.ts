import { describe, expect, it, vi } from 'vitest'
import { waitForServerState } from '../serverStatus'

describe('waitForServerState', () => {
  it('waits until the requested server state is observed', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ servers: [{ id: 7, running: true, pid: '123' }] })
      .mockResolvedValueOnce({ servers: [{ id: 7, running: false, pid: null }] })
    const observed: boolean[] = []

    await expect(waitForServerState(fetchStatus, 7, false, status => observed.push(status.running), { pollMs: 0 }))
      .resolves.toBe(true)

    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(observed).toEqual([true, false])
  })

  it('times out when the server never reaches the requested state', async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ servers: [{ id: 7, running: true, pid: '123' }] })

    await expect(waitForServerState(fetchStatus, 7, false, undefined, { timeoutMs: 0, pollMs: 0 }))
      .resolves.toBe(false)
    expect(fetchStatus).toHaveBeenCalledOnce()
  })
})
