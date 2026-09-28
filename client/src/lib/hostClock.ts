/**
 * Re-expresses a timestamp the panel host read off its own clock -- a game
 * server's process or container start time -- in this browser's clock.
 *
 * Uptime is counted in the browser (so it keeps moving between polls) from
 * a start time the host reported: /proc's boot time, Win32_Process's
 * CreationDate or Docker's StartedAt, all on the host's clock. Any skew
 * between the two clocks would go straight into the displayed uptime -- a
 * host running ahead shows a fresh server as "up 0s" for as long as the
 * skew, one running behind inflates every uptime -- and the codebase
 * already treats host clock drift as real (Debug's runtime.timeSkew check:
 * WSL2 and VM clocks drift). Status payloads therefore carry `serverTime`,
 * the host's clock as it answered; shifting the start time by
 * (receivedAt - serverTime) takes the skew out, leaving only the request's
 * own one-way latency as error.
 *
 * Call it as the response arrives (the API layer does), so receivedAt is
 * the receipt moment. Without a usable serverTime (an older server, demo
 * data) the value passes through unchanged.
 */
export function hostTimeToLocal<T extends string | null | undefined>(
  value: T,
  serverTime: unknown,
  receivedAt: number = Date.now(),
): T | string {
  if (!value || typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return value
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return value
  return new Date(ms + (receivedAt - serverTime)).toISOString()
}
