import { describe, expect, it, vi } from 'vitest'
import { resolveClientProvider, resolveServerRunning, waitForServerState } from '../serverStatus'

describe('resolveClientProvider', () => {
  it('returns null for no server', () => {
    expect(resolveClientProvider(null)).toBeNull()
    expect(resolveClientProvider(undefined)).toBeNull()
  })

  it('maps isRemote to remote-sftp regardless of any docker fields', () => {
    expect(resolveClientProvider({ isRemote: true })).toBe('remote-sftp')
    expect(resolveClientProvider({ isRemote: true, dockerContainerName: 'pz' })).toBe('remote-sftp')
  })

  // GH#114: isRemote === false does NOT mean "the local process scan can see
  // this server" -- a docker-managed server's process runs in a different
  // container. dockerContainerName must be checked before defaulting to
  // native, or a Docker provider gets misread as a locally-scannable one.
  it('maps a dockerContainerName mapping to docker-local, not native', () => {
    expect(resolveClientProvider({ isRemote: false, dockerContainerName: 'pz-server' })).toBe(
      'docker-local',
    )
  })

  it('defaults to native only when neither isRemote nor dockerContainerName is set', () => {
    expect(resolveClientProvider({ isRemote: false })).toBe('native')
    expect(resolveClientProvider({})).toBe('native')
  })
})

// A ServerConfig.tsx save-guard's un-hardened sibling (bug-hunt-2026-08-26,
// found by Dwight): ServerConfig.tsx used to trust serverApi.getStatus()
// (the raw local scan) unconditionally, the same GH#114 root cause, so a
// live docker container could compute serverRunning=false and silently
// suppress its "stop the server before editing" guard. resolveServerRunning
// is the extracted, fetcher-injected fix -- same DI shape as
// waitForServerState above, so the fail-closed contract can be asserted
// directly rather than only through a full component render.
describe('resolveServerRunning', () => {
  const composed = (host: string, server: string, bridge: string) => ({
    host: { status: host },
    server: { status: server },
    bridge: { status: bridge },
  })

  it('native: reads the raw local scan directly, unchanged from before this fix', async () => {
    const fetchNativeStatus = vi.fn().mockResolvedValue({ running: true })
    const fetchComposedStatus = vi.fn()
    await expect(resolveServerRunning({ isRemote: false }, fetchNativeStatus, fetchComposedStatus))
      .resolves.toBe(true)
    expect(fetchComposedStatus).not.toHaveBeenCalled()

    await expect(
      resolveServerRunning({ isRemote: false }, vi.fn().mockResolvedValue({ running: false }), fetchComposedStatus),
    ).resolves.toBe(false)
  })

  it('native: a failed lookup is unknown (null), not a confident false', async () => {
    const fetchNativeStatus = vi.fn().mockRejectedValue(new Error('network error'))
    await expect(resolveServerRunning({ isRemote: false }, fetchNativeStatus, vi.fn())).resolves.toBeNull()
  })

  it('docker-managed: a running container is detected via the composed status even though the local scan cannot see it', async () => {
    const fetchNativeStatus = vi.fn().mockResolvedValue({ running: false }) // must NOT be consulted
    const fetchComposedStatus = vi.fn().mockResolvedValue(composed('running', 'disconnected', 'offline'))
    await expect(
      resolveServerRunning({ isRemote: false, dockerContainerName: 'pz' }, fetchNativeStatus, fetchComposedStatus),
    ).resolves.toBe(true)
    expect(fetchNativeStatus).not.toHaveBeenCalled()
  })

  it('docker-managed: RCON connected or bridge active is also treated as running, even if the host signal itself is not', async () => {
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('stopped', 'connected', 'offline')),
      ),
    ).resolves.toBe(true)
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('stopped', 'disconnected', 'active')),
      ),
    ).resolves.toBe(true)
  })

  it('docker-managed: confirmed stopped only when every signal positively says so', async () => {
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('stopped', 'disconnected', 'offline')),
      ),
    ).resolves.toBe(false)
  })

  it('FAIL CLOSED: an indeterminate host signal is unknown (null), never demoted to confirmed-stopped', async () => {
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('unknown', 'disconnected', 'offline')),
      ),
    ).resolves.toBeNull()
    await expect(
      resolveServerRunning(
        { isRemote: true },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('not-applicable', 'disconnected', 'offline')),
      ),
    ).resolves.toBeNull()
  })

  it('FAIL CLOSED: the composed-status lookup itself failing is unknown (null), guard stays active -- this is the shape of the actual bug (a call that SUCCEEDS with a wrong answer is the dangerous case, not one that throws, but a throw still must not become a permissive value)', async () => {
    await expect(
      resolveServerRunning({ dockerContainerName: 'pz' }, vi.fn(), vi.fn().mockRejectedValue(new Error('down'))),
    ).resolves.toBeNull()
  })

  it('FAIL CLOSED: no active server at all is unknown (null), not a free pass to save', async () => {
    await expect(resolveServerRunning(null, vi.fn(), vi.fn())).resolves.toBeNull()
    await expect(resolveServerRunning(undefined, vi.fn(), vi.fn())).resolves.toBeNull()
  })
})

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
