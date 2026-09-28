import { useCallback, useEffect, useRef, useState } from 'react'
import { panelBridgeApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import type { DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import { useSocket } from '@/contexts/SocketContext'
import { useRequestGuard } from '@/hooks/useRequestGuard'

// panelBridge:modStatus is pushed on every bridge heartbeat, far more often
// than the delivery state can change; a refetch per push would turn each
// heartbeat into a disk scan on the server (loose files, ini, console log).
const MOD_STATUS_REFETCH_MIN_MS = 10_000
// workshop-waiting flips to confirmed/not-loaded on the server's clock (a
// fresh heartbeat or the 5-minute grace running out), which no socket event
// announces on its own -- so that one state polls.
const WAITING_POLL_MS = 10_000

export interface UseBridgeDeliveryOptions {
  // The active server's id, only as a refetch trigger: GET /delivery is
  // called without it so the server always answers for whatever is active
  // right now, instead of a stale id from this page's own server list
  // producing a 409 PANELBRIDGE_DELIVERY_NOT_ACTIVE_SERVER flash.
  activeServerId?: string | number | null
  // False for a role holding none of the capabilities GET /delivery accepts
  // (bridge.setup, bridge.diagnostics, serverfiles.manage, mods.manage):
  // no request, no polling into a guaranteed 403.
  enabled?: boolean
}

export interface UseBridgeDeliveryResult {
  status: DeliveryStatus | null
  loading: boolean
  error: unknown
  refetch: () => Promise<DeliveryStatus | null>
}

export function useBridgeDelivery({ activeServerId = null, enabled = true }: UseBridgeDeliveryOptions = {}): UseBridgeDeliveryResult {
  const [status, setStatus] = useState<DeliveryStatus | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<unknown>(null)
  const guard = useRequestGuard()
  const mountedRef = useRef(true)
  // Refetches run on every server:status event and up to every 10 s from
  // heartbeats, so a route that keeps failing (a 403, the server not
  // updated yet) would otherwise send a client-error report per refetch
  // for as long as the tab is open. One report per failure streak.
  const failureReportedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refetch = useCallback(async (): Promise<DeliveryStatus | null> => {
    if (!enabled) return null
    const requestId = guard.next()
    try {
      const next = await panelBridgeApi.getDelivery()
      failureReportedRef.current = false
      if (!mountedRef.current || guard.isStale(requestId)) return next
      setStatus(next)
      setError(null)
      return next
    } catch (err) {
      if (!mountedRef.current || guard.isStale(requestId)) return null
      if (!failureReportedRef.current) {
        failureReportedRef.current = true
        reportClientError('Failed to fetch PanelBridge delivery status.', err)
      }
      // The last good status stays on screen (a blip shouldn't blank the
      // block); the caller shows `error` beside it as "couldn't refresh".
      setError(err)
      return null
    } finally {
      if (mountedRef.current && !guard.isStale(requestId)) setLoading(false)
    }
  }, [enabled, guard])

  // Mount, and every active-server change. On a real switch from one
  // server to another -- or to none, when the active server was deleted --
  // the old status is dropped first, so its buttons can't act on the new
  // server while the refetch is in flight. The page's own server list
  // arriving (null -> id) is not a switch: the status already fetched is
  // for that same active server, so it stays on screen.
  const lastServerIdRef = useRef(activeServerId)
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const previous = lastServerIdRef.current
    lastServerIdRef.current = activeServerId
    if (previous != null && (activeServerId == null || String(previous) !== String(activeServerId))) {
      setStatus(null)
      setError(null)
      setLoading(true)
    }
    void refetch()
  }, [enabled, activeServerId, refetch])

  const socket = useSocket()
  const refetchRef = useRef(refetch)
  useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])

  useEffect(() => {
    if (!socket || !enabled) return
    let lastModStatusRefetch = 0
    let trailing: ReturnType<typeof setTimeout> | null = null

    // Leading edge plus one trailing call: the first heartbeat refetches at
    // once, later ones inside the window collapse into a single refetch at
    // its end, so the last change in a burst is never lost.
    const onModStatus = () => {
      const elapsed = Date.now() - lastModStatusRefetch
      if (elapsed >= MOD_STATUS_REFETCH_MIN_MS) {
        lastModStatusRefetch = Date.now()
        void refetchRef.current()
        return
      }
      if (trailing) return
      trailing = setTimeout(() => {
        trailing = null
        lastModStatusRefetch = Date.now()
        void refetchRef.current()
      }, MOD_STATUS_REFETCH_MIN_MS - elapsed)
    }
    // Emitted on running/phase changes and lifecycle actions, never on a
    // timer (server/index.js checkServerStatusNow, routes/server.js), so
    // no throttle is needed.
    const onServerStatus = () => {
      void refetchRef.current()
    }

    socket.on('panelBridge:modStatus', onModStatus)
    socket.on('server:status', onServerStatus)
    return () => {
      socket.off('panelBridge:modStatus', onModStatus)
      socket.off('server:status', onServerStatus)
      if (trailing) clearTimeout(trailing)
    }
  }, [socket, enabled])

  const waiting = status?.state === 'workshop-waiting'
  useEffect(() => {
    if (!waiting || !enabled) return
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refetchRef.current()
    }, WAITING_POLL_MS)
    return () => clearInterval(id)
  }, [waiting, enabled])

  return { status, loading, error, refetch }
}
