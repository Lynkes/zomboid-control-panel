import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Socket } from 'socket.io-client'
import { SocketContext } from '@/contexts/SocketContext'
import { panelBridgeApi } from '@/lib/api'
import { useBridgeDelivery } from '../useBridgeDelivery'
import { makeLocalStatus, makeWorkshopStatus } from '@/components/bridge/__tests__/deliveryFixtures'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, panelBridgeApi: { ...actual.panelBridgeApi, getDelivery: vi.fn() } }
})

vi.mock('@/lib/client-errors', () => ({ reportClientError: vi.fn(), reportClientWarning: vi.fn() }))

const getDelivery = vi.mocked(panelBridgeApi.getDelivery)

function makeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(fn)
    },
    off: (event: string, fn: (...args: unknown[]) => void) => handlers.get(event)?.delete(fn),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.forEach((fn) => fn(...args)),
  }
  return socket
}

function wrapperFor(socket: ReturnType<typeof makeSocket> | null) {
  return ({ children }: { children: ReactNode }) => (
    <SocketContext.Provider value={socket as unknown as Socket | null}>{children}</SocketContext.Provider>
  )
}

// Flush resolved fetch promises and the state updates they trigger.
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useBridgeDelivery', () => {
  it('fetches on mount, always for whatever server is active (no id in the request)', async () => {
    getDelivery.mockResolvedValue(makeLocalStatus())
    const { result } = renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1' }), { wrapper: wrapperFor(null) })
    expect(result.current.loading).toBe(true)
    await flush()
    expect(getDelivery).toHaveBeenCalledTimes(1)
    expect(getDelivery).toHaveBeenCalledWith()
    expect(result.current.status?.state).toBe('local-ok')
    expect(result.current.loading).toBe(false)
  })

  it('refetches when the active server changes, dropping the old status in between', async () => {
    getDelivery.mockResolvedValue(makeLocalStatus())
    const { result, rerender } = renderHook(({ id }) => useBridgeDelivery({ activeServerId: id }), {
      wrapper: wrapperFor(null),
      initialProps: { id: 'srv-1' },
    })
    await flush()
    let resolveNext: (value: ReturnType<typeof makeLocalStatus>) => void = () => {}
    getDelivery.mockReturnValueOnce(new Promise((resolve) => { resolveNext = resolve }))
    rerender({ id: 'srv-2' })
    expect(result.current.status).toBeNull()
    expect(result.current.loading).toBe(true)
    await act(async () => {
      resolveNext(makeLocalStatus({ serverId: 'srv-2', serverName: 'Second' }))
    })
    expect(result.current.status?.serverId).toBe('srv-2')
    expect(getDelivery).toHaveBeenCalledTimes(2)
  })

  it('keeps the status on screen when the page merely learns the active id (null -> id)', async () => {
    getDelivery.mockResolvedValue(makeLocalStatus())
    const { result, rerender } = renderHook(({ id }) => useBridgeDelivery({ activeServerId: id }), {
      wrapper: wrapperFor(null),
      initialProps: { id: null as string | null },
    })
    await flush()
    rerender({ id: 'srv-1' })
    expect(result.current.status).not.toBeNull()
  })

  it('refetches on server:status', async () => {
    const socket = makeSocket()
    getDelivery.mockResolvedValue(makeWorkshopStatus({ state: 'workshop-restart-needed' }))
    renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1' }), { wrapper: wrapperFor(socket) })
    await flush()
    act(() => socket.emit('server:status', { running: true, phase: 'running' }))
    await flush()
    expect(getDelivery).toHaveBeenCalledTimes(2)
  })

  it('throttles panelBridge:modStatus to one refetch per 10 s, keeping the last one', async () => {
    const socket = makeSocket()
    getDelivery.mockResolvedValue(makeWorkshopStatus())
    renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1' }), { wrapper: wrapperFor(socket) })
    await flush()
    expect(getDelivery).toHaveBeenCalledTimes(1)

    act(() => socket.emit('panelBridge:modStatus', { alive: true }))
    await flush()
    expect(getDelivery).toHaveBeenCalledTimes(2)

    for (let i = 0; i < 5; i++) {
      act(() => socket.emit('panelBridge:modStatus', { alive: true }))
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    }
    expect(getDelivery).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getDelivery).toHaveBeenCalledTimes(3)
  })

  it('polls every 10 s while workshop-waiting, and stops once the state moves on', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus({ state: 'workshop-waiting' }))
    renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1' }), { wrapper: wrapperFor(null) })
    await flush()
    expect(getDelivery).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getDelivery).toHaveBeenCalledTimes(2)

    getDelivery.mockResolvedValue(makeWorkshopStatus({ state: 'workshop-confirmed' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getDelivery).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(getDelivery).toHaveBeenCalledTimes(3)
  })

  it('does not poll in other states', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus({ state: 'workshop-restart-needed' }))
    renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1' }), { wrapper: wrapperFor(null) })
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getDelivery).toHaveBeenCalledTimes(1)
  })

  it('keeps the error and no status when the fetch fails, and refetch() recovers', async () => {
    getDelivery.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1' }), { wrapper: wrapperFor(null) })
    await flush()
    expect(result.current.status).toBeNull()
    expect(result.current.error).toBeInstanceOf(Error)
    getDelivery.mockResolvedValue(makeLocalStatus())
    await act(async () => { await result.current.refetch() })
    expect(result.current.status?.state).toBe('local-ok')
    expect(result.current.error).toBeNull()
  })

  it('does nothing at all when disabled (no capability to read it)', async () => {
    const socket = makeSocket()
    const { result } = renderHook(() => useBridgeDelivery({ activeServerId: 'srv-1', enabled: false }), { wrapper: wrapperFor(socket) })
    await flush()
    act(() => socket.emit('server:status', {}))
    await flush()
    expect(getDelivery).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })
})
