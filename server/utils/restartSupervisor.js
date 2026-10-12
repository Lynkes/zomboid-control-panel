export function isLinuxPanelSupervisor({ platform = process.platform, env = process.env } = {}) {
  return (
    platform === "linux" &&
    env.PANEL_SUPERVISOR_V === "2" &&
    env.PANEL_PRESERVE_GAME_SERVERS === "1"
  );
}

// Start.bat (supervisor v2) sets PANEL_SUPERVISOR_V=2 for the panel it
// launches and relaunches it on exit code 75. A panel that respawns itself
// instead leaves the supervisor seeing a clean exit 0 ("Panel exited cleanly")
// and quitting, so a later restart-and-apply exits 75 into nothing.
export function isWindowsPanelSupervisor({ platform = process.platform, env = process.env } = {}) {
  return platform === "win32" && env.PANEL_SUPERVISOR_V === "2";
}

/**
 * Whether something outside this process (systemd, Docker, Podman) brings the
 * panel back after it exits: systemd sets INVOCATION_ID or NOTIFY_SOCKET for a
 * service unit, and a container has /.dockerenv (Docker) or /run/.containerenv
 * (Podman). A panel that respawns itself under either would run twice (systemd)
 * or die with the container anyway (Docker, where it is PID 1).
 */
export function isOrchestratedProcess({ env = process.env, existsSync = () => false } = {}) {
  try {
    if (env.INVOCATION_ID || env.NOTIFY_SOCKET) return true;
    return Boolean(existsSync("/.dockerenv") || existsSync("/run/.containerenv"));
  } catch {
    return false;
  }
}
