import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostTimeToLocal } from '../hostClock'
import { serverApi, serversApi } from '../api'

// Uptime is counted in the browser from a start time read off the HOST's
// clock (/proc btime, Win32_Process.CreationDate, Docker's StartedAt), so
// host/browser clock skew used to go straight into the displayed uptime: a
// host 5 minutes ahead showed a fresh server as "up 0s" for 5 minutes, one
// behind inflated every uptime. Status payloads now carry serverTime (the
// host's clock as it answered) and the API layer re-expresses start times
// in the browser's clock on receipt.

const HOST_NOW = Date.UTC(2026, 8, 27, 12, 5, 0) // host clock runs 5 min ahead
const BROWSER_NOW = Date.UTC(2026, 8, 27, 12, 0, 0)
const HOST_STARTED = '2026-09-27T11:05:00.000Z' // 1h before the host's now

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('hostTimeToLocal', () => {
  it('shifts a host timestamp by the host/browser clock difference', () => {
    expect(hostTimeToLocal(HOST_STARTED, HOST_NOW, BROWSER_NOW)).toBe('2026-09-27T11:00:00.000Z')
  })

  it('passes the value through when there is no usable serverTime (older server, demo data)', () => {
    expect(hostTimeToLocal(HOST_STARTED, undefined, BROWSER_NOW)).toBe(HOST_STARTED)
    expect(hostTimeToLocal(HOST_STARTED, 'soon', BROWSER_NOW)).toBe(HOST_STARTED)
  })

  it('leaves an absent or unparseable start time alone -- unknown stays unknown', () => {
    expect(hostTimeToLocal(null, HOST_NOW, BROWSER_NOW)).toBeNull()
    expect(hostTimeToLocal(undefined, HOST_NOW, BROWSER_NOW)).toBeUndefined()
    expect(hostTimeToLocal('not a date', HOST_NOW, BROWSER_NOW)).toBe('not a date')
  })
})

describe('status API calls hand the UI start times in the browser clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: BROWSER_NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('the composed status (dashboard header, selected server card)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      provider: 'native', selected: true, summary: '',
      host: { status: 'running', label: 'Process', detail: null, startedAt: HOST_STARTED },
      server: { status: 'connected', label: 'RCON', detail: null },
      bridge: { status: 'not-installed', label: 'PanelBridge', detail: null },
      serverTime: HOST_NOW,
    }))

    const status = await serversApi.getComposedStatus({ retries: 0 })

    expect(status.host.startedAt).toBe('2026-09-27T11:00:00.000Z')
  })

  it('the per-server list (Managed Servers cards)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      servers: [
        { id: '1', name: 'A', running: true, pid: '42', isActive: false, startedAt: HOST_STARTED },
        { id: '2', name: 'B', running: false, pid: null, isActive: false, startedAt: null },
      ],
      detectedProcesses: 1,
      detectionError: null,
      serverTime: HOST_NOW,
    }))

    const data = await serversApi.getStatus({ retries: 0 })

    expect(data.servers[0].startedAt).toBe('2026-09-27T11:00:00.000Z')
    expect(data.servers[1].startedAt).toBeNull()
  })

  it('the local-scan snapshot', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      running: true, startTime: HOST_STARTED, uptime: 3600, serverTime: HOST_NOW,
    }))

    const status = await serverApi.getStatus({ retries: 0 })

    expect(status.startTime).toBe('2026-09-27T11:00:00.000Z')
    expect(status.uptime).toBe(3600)
  })
})
