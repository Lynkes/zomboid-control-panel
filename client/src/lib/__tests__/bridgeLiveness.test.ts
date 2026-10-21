import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, panelBridgeApi, serversApi } from '@/lib/api'
import { canReadFullBridgeStatus, readBridgeLiveness } from '@/lib/bridgeLiveness'

// GET /panel-bridge/status is bridge.setup / bridge.diagnostics only. Players,
// Events, World Map and Leaderboard used it to decide whether the bridge was
// up, so for the default Moderator (neither capability) every answer was a
// 403, read as "bridge offline": God mode, weather, clock and the rest were
// greyed out while the bridge was running fine.

type Composed = Awaited<ReturnType<typeof serversApi.getComposedStatus>>
type Full = Awaited<ReturnType<typeof panelBridgeApi.getStatus>>

function composed(bridgeStatus: string): Composed {
  const signal = { status: 'connected', label: 'x', detail: null }
  return {
    provider: 'native',
    selected: true,
    host: signal,
    server: signal,
    bridge: { status: bridgeStatus, label: 'PanelBridge', detail: null },
    summary: '',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('canReadFullBridgeStatus', () => {
  it('needs bridge.setup or bridge.diagnostics', () => {
    expect(canReadFullBridgeStatus((c) => c === 'bridge.setup')).toBe(true)
    expect(canReadFullBridgeStatus((c) => c === 'bridge.diagnostics')).toBe(true)
    const moderator = ['players.moderate', 'players.gm_tools', 'players.view', 'server.world_events']
    expect(canReadFullBridgeStatus((c) => moderator.includes(c))).toBe(false)
  })
})

describe('readBridgeLiveness', () => {
  it('reads the detailed status when the role may', async () => {
    const full = { isRunning: true, modConnected: true, modStatus: { version: '1.7.77' } } as unknown as Full
    const getStatus = vi.spyOn(panelBridgeApi, 'getStatus').mockResolvedValue(full)
    const getComposed = vi.spyOn(serversApi, 'getComposedStatus')
    await expect(readBridgeLiveness(true)).resolves.toEqual({ isRunning: true, modConnected: true, full })
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(getComposed).not.toHaveBeenCalled()
  })

  it('asks the status every role may read when the role may not read the detailed one', async () => {
    const getStatus = vi.spyOn(panelBridgeApi, 'getStatus')
    vi.spyOn(serversApi, 'getComposedStatus').mockResolvedValue(composed('active'))
    await expect(readBridgeLiveness(false)).resolves.toEqual({ isRunning: true, modConnected: true, full: null })
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('reads an offline or missing bridge as down', async () => {
    vi.spyOn(serversApi, 'getComposedStatus').mockResolvedValue(composed('offline'))
    await expect(readBridgeLiveness(false)).resolves.toMatchObject({ modConnected: false, isRunning: false })
    vi.spyOn(serversApi, 'getComposedStatus').mockResolvedValue(composed('not-installed'))
    await expect(readBridgeLiveness(false)).resolves.toMatchObject({ modConnected: false, isRunning: false })
  })

  it('falls back on a 403 (capabilities still loading) but not on other failures', async () => {
    vi.spyOn(panelBridgeApi, 'getStatus').mockRejectedValueOnce(
      new ApiError('Insufficient permissions', { status: 403, code: 'PERMISSION_DENIED' }),
    )
    vi.spyOn(serversApi, 'getComposedStatus').mockResolvedValue(composed('active'))
    await expect(readBridgeLiveness(true)).resolves.toMatchObject({ modConnected: true, full: null })

    const down = new ApiError('The server is temporarily unavailable.', { status: 503 })
    vi.spyOn(panelBridgeApi, 'getStatus').mockRejectedValueOnce(down)
    await expect(readBridgeLiveness(true)).rejects.toBe(down)
  })
})
