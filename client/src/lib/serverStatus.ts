export interface ServerStatusEntry {
  id: string | number
  running: boolean
  pid: string | null
}

export interface ServerStatusResponse {
  servers: ServerStatusEntry[]
}

export async function waitForServerState(
  fetchStatus: () => Promise<ServerStatusResponse>,
  serverId: string | number,
  expectedRunning: boolean,
  onStatus?: (status: ServerStatusEntry) => void,
  { timeoutMs = 30000, pollMs = 1000 }: { timeoutMs?: number; pollMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const data = await fetchStatus()
      const serverStatus = data.servers?.find((entry) => String(entry.id) === String(serverId))
      if (serverStatus) {
        onStatus?.(serverStatus)
        if (serverStatus.running === expectedRunning) return true
      }
    } catch {
      // A short process transition can briefly interrupt the status endpoint.
    }

    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
}
