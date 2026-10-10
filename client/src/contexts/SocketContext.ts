import { createContext, useContext } from 'react'
import { Socket } from 'socket.io-client'

export interface ConnectionStatus {
  connected: boolean
  reconnecting: boolean
  /**
   * The first connect of this page load is still in flight, so nothing has
   * failed yet and the "Live Updates Unavailable" notice must stay hidden.
   * Cleared by the first connect, failure or disconnect.
   */
  connecting?: boolean
  reconnectAttempt: number
  error: string | null
}

export const SocketContext = createContext<Socket | null>(null)
export const ConnectionStatusContext = createContext<ConnectionStatus>({
  connected: false,
  reconnecting: false,
  reconnectAttempt: 0,
  error: null,
})

export function useSocket() {
  return useContext(SocketContext)
}

export function useConnectionStatus() {
  return useContext(ConnectionStatusContext)
}
