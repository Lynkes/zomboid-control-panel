/**
 * Composes the 3-signal server status model: is the host process/container
 * alive, is RCON connected, is PanelBridge active. Kept separate from
 * isServerObservedRunning (which OR-combines the same signals into one
 * running/stopped verdict for the watchdog) — here each signal stays
 * independently visible so "container running, RCON down" doesn't collapse
 * into a single misleading "Stopped".
 *
 * `server.provider` is read first so a future Docker-aware server record is
 * honoured without changing this module. For "docker-local"/"docker-managed"
 * the host signal comes from `dockerContainer` (a managedContainer.js
 * resolveManagedContainer() result, resolved by the route) — never from the
 * local process scan, which can only ever see processes in *this* container
 * and has no way to observe a PZ process running in a different one. See
 * buildHostSignal below for how a missing/failed Docker lookup degrades to
 * "unknown" rather than a confident "stopped".
 */

const HOST_LABELS = {
  native: "Process",
  "docker-local": "Container",
  "docker-managed": "Container",
  "remote-sftp": "Host",
};

export function resolveProvider(server) {
  if (server?.provider) return server.provider;
  if (server?.dockerContainerId || server?.dockerContainerName) {
    return "docker-local";
  }
  return server?.isRemote ? "remote-sftp" : "native";
}

// Kept as a local list rather than importing linuxServiceLifecycle.js's
// isManagedLifecycleProvider(): this module stays free of the fs/exec
// dependencies that one carries.
const MANAGED_LIFECYCLE_PROVIDERS = ["systemd", "openrc"];

/**
 * Whether a CONFIDENT host answer for this provider -- a native scan that
 * completed, a managed unit whose state was confirmed, a Docker container
 * whose state was resolved -- is the final word on whether the server is
 * up, overruling RCON and PanelBridge. It is the caller's job to check the
 * answer was confident (not scanFailed / "unknown"); this only says whether
 * the provider's host signal gets that authority at all. Remote hosts never
 * do: the panel cannot see them.
 *
 * answeredBy: the `provider` field serverManager.getServerProcessDetails()
 * stamps on its result -- the lifecycle provider's name when a managed
 * systemd/openrc unit's own state answered (usesManagedServiceLifecycle()),
 * absent when the plain process scan did. A unit that answered is as
 * authoritative as a completed scan: the panel's systemd unit is
 * Type=simple with KillMode=control-group, so "inactive"/"failed" means
 * every process in it (the JVM, and the PanelBridge mod inside it) is gone
 * (OpenRC's supervise-daemon likewise takes its child down on stop), and
 * linuxServiceLifecycle.js's status() already downgrades every state it
 * cannot vouch for (unregistered unit, failed ownership check, "unknown",
 * "deactivating") to scanFailed. Leaving managed units out entirely kept the
 * reported bug alive there: after a Stop that systemctl had confirmed, an
 * exited server's PanelBridge heartbeat still outvoted the unit for up to
 * five minutes. Only when a systemd/openrc server's answer came from the
 * plain scan instead (this ServerManager has not loaded that record) do
 * RCON and PanelBridge still get to vouch, as for any process the strict
 * attribution may have missed.
 *
 * One definition shared by the watchdog's verdict (utils/serverStatus.js's
 * resolveObservedServerRunning -> isServerObservedRunning's
 * hostStateAuthoritative) and composeServerStatus below, so the push that
 * says "stopped" and the badges a client refetches because of it cannot
 * disagree about which signal wins.
 */
export function isHostSignalAuthoritative(provider, lifecycleProvider = null, answeredBy = null) {
  if (provider === "docker-local" || provider === "docker-managed") return true;
  if (provider !== "native") return false;
  if (!MANAGED_LIFECYCLE_PROVIDERS.includes(lifecycleProvider)) return true;
  return answeredBy === lifecycleProvider;
}

// scanFailed distinguishes "the process-detection scan itself could not
// tell" from "it ran fine and found nothing" -- both used to collapse into
// a bare isRunning: false here, which is how a dashboard host badge and a
// destructive-operation guard (server/routes/server.js's /wipe, which reads
// getServerProcessDetails().scanFailed directly) ended up disagreeing about
// the same server: the guard correctly refused on scanFailed, the dashboard
// had nowhere to put that signal and confidently rendered "stopped." When
// scanFailed is true this always wins over isRunning for the native
// provider -- reuses the same "unknown" status remote-sftp already renders
// correctly on the client (ServerStatusBadge.tsx).
//
// dockerContainer is the resolveManagedContainer() outcome for docker
// providers (see server/services/managedContainer.js). isRunning/scanFailed
// are the local process-scan result and are deliberately IGNORED for
// docker-local/docker-managed: PZ runs as PID 1 of a *different* container
// there, so a local scan can never see it and would always, confidently,
// wrongly say stopped (GH#114) -- the label adapted to the topology but the
// data source didn't. A missing/unresolved dockerContainer (Docker control
// disabled, socket unavailable, or the mapped container not found/managed)
// degrades to "unknown", the same fail-closed pattern as a failed native
// scan -- never a silent fall-back to the local scan, which would just
// reintroduce this bug with extra steps.
// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): turns
// server/index.js's classifyStopReason() result (serverManager.lastStopReason
// -- { reason: 'stop'|'restart'|'crash'|'unknown', exitCode, signal }) into
// the human-readable line buildHostSignal's own `detail` field already
// carries for other statuses (e.g. "Process detection failed"). Returns null
// for 'unknown' (or no reason recorded at all, e.g. right after boot before
// any transition has been observed) rather than guessing -- matches this
// module's own existing fail-closed-to-null convention.
function describeStopReason(stopReason) {
  if (!stopReason) return null;
  switch (stopReason.reason) {
    case "stop":
      return "Stopped by an operator";
    case "restart":
      return "Restarting";
    case "crash":
      return stopReason.exitCode !== null && stopReason.exitCode !== undefined
        ? `Crashed (exit code ${stopReason.exitCode}${stopReason.signal ? `, signal ${stopReason.signal}` : ""})`
        : stopReason.signal
          ? `Crashed (signal ${stopReason.signal})`
          : "Crashed unexpectedly";
    default:
      return null;
  }
}

export function buildHostSignal(provider, isRunning, scanFailed = false, dockerContainer = null, stopReason = null) {
  if (provider === "native") {
    if (scanFailed) {
      return { status: "unknown", label: "Process", detail: "Process detection failed" };
    }
    return {
      status: isRunning ? "running" : "stopped",
      label: "Process",
      detail: isRunning ? null : describeStopReason(stopReason),
    };
  }
  if (provider === "docker-local" || provider === "docker-managed") {
    if (!dockerContainer?.handled) {
      return {
        status: "unknown",
        label: "Container",
        detail: dockerContainer?.error || "Docker container status unavailable",
      };
    }
    if (dockerContainer.error) {
      return { status: "unknown", label: "Container", detail: dockerContainer.error };
    }
    return {
      status: dockerContainer.running ? "running" : "stopped",
      label: "Container",
      detail: null,
    };
  }
  if (provider === "remote-sftp") {
    return {
      status: "unknown",
      label: "Host",
      detail: "Cannot verify without SFTP access",
    };
  }
  return { status: "not-applicable", label: HOST_LABELS[provider] || "Host", detail: null };
}

export function buildServerSignal({ connected, connecting, host, port } = {}) {
  const status = connected ? "connected" : connecting ? "connecting" : "disconnected";
  const detail = host && port ? `${host}:${port}` : null;
  return { status, label: "RCON", detail };
}

// hostConfirmedStopped: an authoritative host signal (isHostSignalAuthoritative)
// has just confirmed the process/container gone. PanelBridge's own liveness
// is nothing more than the age of the mod's status.json (panelBridge.js's
// checkModStatus: 45s, or 5 minutes when the last write reported 0 players,
// statusStaleIdleMs) -- so the last heartbeat an exited server wrote kept
// this signal "active" for up to five minutes after every quiet stop. Both
// the server card and the Dashboard offer Stop while ANY signal is live, so
// they kept showing Stop right beside "Process Down" (2026-09 Discord
// report, Windows native). The mod runs inside that process: once the
// process is confirmed gone, its heartbeat cannot be live.
export function buildBridgeSignal({ configured, running, modConnected, hostConfirmedStopped = false } = {}) {
  if (!configured) return { status: "not-installed", label: "PanelBridge", detail: null };
  const status = running && modConnected && !hostConfirmedStopped ? "active" : "offline";
  return { status, label: "PanelBridge", detail: null };
}

const HOST_WORDS = {
  running: "running",
  stopped: "stopped",
  unknown: "unknown",
  "not-applicable": "not applicable",
};
const SERVER_WORDS = { connected: "connected", disconnected: "disconnected", connecting: "connecting" };

export function buildSummary(host, serverSignal) {
  const hostWord = HOST_WORDS[host.status] || host.status;
  const serverWord = SERVER_WORDS[serverSignal.status] || serverSignal.status;
  return `${host.label} ${hostWord}, ${serverSignal.label} ${serverWord}`;
}

// server: the active server DB record. isRunning: serverManager's tracked
// process state (native provider only -- see buildHostSignal). scanFailed:
// whether the process-detection scan behind isRunning could actually tell.
// dockerContainer: the resolveManagedContainer() outcome for docker
// providers. rcon/bridge: plain snapshots pulled from the live services by
// the route handler, so this function stays framework-free and testable.
// stopReason (round 28): serverManager.lastStopReason as-is, or undefined/
// null on a server that's running or has never been observed to stop --
// describeStopReason handles both the same way (no detail).
// hostAnsweredBy: the process details' `provider` (see
// isHostSignalAuthoritative's answeredBy) -- which of a systemd/openrc
// server's unit or the plain scan produced isRunning/scanFailed.
export function composeServerStatus({ server, isRunning, scanFailed, rcon, bridge, dockerContainer, stopReason, hostAnsweredBy }) {
  const provider = resolveProvider(server);
  const host = buildHostSignal(provider, isRunning, scanFailed, dockerContainer, stopReason);
  const serverSignal = buildServerSignal(rcon);
  // Only a confident "stopped" from a provider whose host signal is
  // authoritative -- an "unknown" host (failed scan, unresolved container,
  // remote) and a systemd/openrc server answered by the plain scan keep
  // whatever the bridge says, the same cases the watchdog still lets
  // RCON/PanelBridge decide. The flip side, accepted with the watchdog's
  // own verdict: a live PZ process the completed scan cannot attribute to
  // this server reads PanelBridge offline here even while its mod is still
  // writing -- the panel already calls that host stopped everywhere else.
  const hostConfirmedStopped =
    host.status === "stopped" &&
    isHostSignalAuthoritative(provider, server?.lifecycleProvider, hostAnsweredBy);
  const bridgeSignal = buildBridgeSignal({ ...bridge, hostConfirmedStopped });
  return {
    provider,
    selected: true,
    host,
    server: serverSignal,
    bridge: bridgeSignal,
    summary: buildSummary(host, serverSignal),
  };
}
