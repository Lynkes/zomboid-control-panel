/**
 * Determines whether any trustworthy signal proves the active server is up.
 * Process ownership remains necessary for process-control operations.
 */
export function isServerObservedRunning({
  processRunning = false,
  rconConnected = false,
  bridgeConnected = false,
  processScanFailed = false,
} = {}) {
  if (processScanFailed && !rconConnected && !bridgeConnected) return null;
  return Boolean(processRunning || rconConnected || bridgeConnected);
}
