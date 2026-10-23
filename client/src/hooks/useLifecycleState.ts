import { useEffect, useState } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import { serversApi, type LifecycleState } from '@/lib/api'

// The lifecycle lock and every server's wait for its RCON, kept current by
// the server's lifecycle:state push (lifecycleCoordinator.js), read once on
// mount and again on every reconnect. null until the first answer: callers
// then treat nothing as busy, and the server still refuses a racing click.
export function useLifecycleState(): LifecycleState | null {
  const socket = useSocket()
  const [state, setState] = useState<LifecycleState | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      // Through a promise, so a missing method (a test's partial api mock)
      // ends up in the catch instead of throwing out of the effect.
      Promise.resolve()
        .then(() => serversApi.getLifecycle())
        .then((next) => { if (!cancelled && next) setState(next) })
        .catch(() => {})
    }
    load()
    if (!socket || typeof socket.on !== 'function') return () => { cancelled = true }
    const onState = (next: LifecycleState) => { if (!cancelled) setState(next) }
    socket.on('lifecycle:state', onState)
    socket.on('connect', load)
    return () => {
      cancelled = true
      socket.off?.('lifecycle:state', onState)
      socket.off?.('connect', load)
    }
  }, [socket])

  return state
}
