// Where the browser should look for the panel after "Restart Panel" or
// "Restart and Apply Update".
//
// The poll used to go to `protocol//hostname:<saved panel port>` every time.
// That is only the right place when the port really changed. Anywhere else the
// saved port is not where this page is reached, so the poll waited three
// minutes for an address that never answers and then reported a failure:
//   - behind a reverse proxy (https://panel.example.com, port 443)
//   - a Docker port that is published under another number (8080 -> 3001)
//   - the HTTPS listener (https://host:3443, while the saved port is the HTTP one)
// In all of those the address that comes back is the one already in the
// address bar.

export interface PanelPageLocation {
  protocol: string
  hostname: string
  host: string
  port: string
}

function parsePort(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null
}

// The port the page is reached on: location.port is empty on the protocol's
// default one (80 for http, 443 for https).
export function servedPort(location: Pick<PanelPageLocation, 'protocol' | 'port'>): number {
  return parsePort(location.port) ?? (location.protocol === 'https:' ? 443 : 80)
}

/**
 * The origin to poll, and to send the browser to once the panel answers.
 *
 * `runningPort` is the HTTP port the panel process is listening on right now
 * (GET /api/panel-info, read before the restart), `savedPort` the one the
 * Settings page has saved. The port really changes only when those two differ
 * AND this page is reached directly on the running port; then the restarted
 * panel comes up on `savedPort`, on the same host. Every other case (same
 * port, a proxy, a remapped or HTTPS port, an unknown running port) keeps the
 * origin the page is already on.
 */
export function resolveRestartOrigin(
  location: PanelPageLocation,
  savedPort: unknown,
  runningPort: unknown,
): string {
  const current = `${location.protocol}//${location.host}`
  const saved = parsePort(savedPort)
  const running = parsePort(runningPort)
  if (saved === null || running === null) return current
  if (saved === running) return current
  if (servedPort(location) !== running) return current
  return `${location.protocol}//${location.hostname}:${saved}`
}

/**
 * The HTTP port the panel is listening on, from GET /api/panel-info, or null
 * when it cannot be told (an older panel, a failed request). Must be asked
 * BEFORE the restart: only the process about to exit can answer.
 */
export async function readRunningPanelPort(
  getPanelInfo: () => Promise<{ port?: unknown } | null | undefined>,
): Promise<number | null> {
  try {
    return parsePort((await getPanelInfo())?.port)
  } catch {
    return null
  }
}
