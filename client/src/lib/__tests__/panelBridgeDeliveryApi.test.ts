import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelBridgeApi } from '../api'

// What the PanelBridge delivery calls actually put on the wire. The
// component tests mock these functions whole, so without this a preview
// that stopped forcing dryRun, or an apply that dropped expectedFrom, would
// pass every client test (the server refuses both, but the operator would
// see an error instead of a preview).
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function lastCall() {
  const [url, init] = vi.mocked(fetch).mock.calls.at(-1) as [string, RequestInit | undefined]
  return { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
}

describe('panelBridgeApi delivery calls', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getDelivery sends no query without a server id, and ?serverId= with one', async () => {
    await panelBridgeApi.getDelivery()
    expect(lastCall()).toMatchObject({ method: 'GET' })
    expect(lastCall().url).toMatch(/\/api\/panel-bridge\/delivery$/)

    await panelBridgeApi.getDelivery('srv 1')
    expect(lastCall().url).toMatch(/\/api\/panel-bridge\/delivery\?serverId=srv%201$/)
  })

  it('planDelivery always previews: dryRun true, no expectedFrom', async () => {
    await panelBridgeApi.planDelivery({ serverId: 'srv-1', method: 'workshop' })
    const call = lastCall()
    expect(call.method).toBe('POST')
    expect(call.url).toMatch(/\/api\/panel-bridge\/delivery$/)
    expect(call.body).toEqual({ serverId: 'srv-1', method: 'workshop', dryRun: true })
  })

  it('applyDelivery applies with the method the operator saw: dryRun false plus expectedFrom', async () => {
    await panelBridgeApi.applyDelivery({ serverId: 'srv-1', method: 'local', expectedFrom: 'workshop' })
    const call = lastCall()
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ serverId: 'srv-1', method: 'local', expectedFrom: 'workshop', dryRun: false })
  })

  it('installModAuto posts the server id to the install endpoint', async () => {
    await panelBridgeApi.installModAuto('srv-1')
    const call = lastCall()
    expect(call.method).toBe('POST')
    expect(call.url).toMatch(/\/api\/panel-bridge\/install-mod-auto$/)
    expect(call.body).toEqual({ serverId: 'srv-1' })
  })
})
