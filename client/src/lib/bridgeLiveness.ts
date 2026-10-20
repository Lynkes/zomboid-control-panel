import { panelBridgeApi, serversApi, type ApiError } from './api'

export type FullBridgeStatus = Awaited<ReturnType<typeof panelBridgeApi.getStatus>>

/**
 * Whether PanelBridge is up, for a page that gates its bridge-backed
 * controls on it. `full` is the detailed GET /panel-bridge/status answer when
 * this role may read it, otherwise null.
 */
export interface BridgeLiveness {
  isRunning: boolean
  modConnected: boolean
  full: FullBridgeStatus | null
}

/**
 * GET /panel-bridge/status carries host paths, so the server only answers it
 * for bridge.setup or bridge.diagnostics. The default Moderator holds
 * neither, yet uses the bridge every day (God mode, weather, the map): read
 * the detailed status only when the role may, and otherwise the bridge
 * signal of GET /servers/active/status, which every role may read.
 */
export function canReadFullBridgeStatus(can: (capability: string) => boolean): boolean {
  return can('bridge.setup') || can('bridge.diagnostics')
}

export async function readBridgeLiveness(canReadFull: boolean): Promise<BridgeLiveness> {
  if (canReadFull) {
    try {
      const full = await panelBridgeApi.getStatus()
      return { isRunning: Boolean(full?.isRunning), modConnected: Boolean(full?.modConnected), full }
    } catch (error) {
      // can() answers yes while the capabilities are still loading; a 403
      // means this role can't read the detailed status after all.
      if ((error as ApiError | null)?.status !== 403) throw error
    }
  }
  const composed = await serversApi.getComposedStatus({ retries: 0 })
  // "active" already means running AND the mod connected (buildBridgeSignal).
  const active = composed?.bridge?.status === 'active'
  return { isRunning: active, modConnected: active, full: null }
}
