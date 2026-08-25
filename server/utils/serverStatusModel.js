/**
 * Composes the 3-signal server status model: is the host process/container
 * alive, is RCON connected, is PanelBridge active. Kept separate from
 * isServerObservedRunning (which OR-combines the same signals into one
 * running/stopped verdict for the watchdog) — here each signal stays
 * independently visible so "container running, RCON down" doesn't collapse
 * into a single misleading "Stopped".
 *
 * This codebase currently only ever produces "native" or "remote-sftp"
 * servers (no Docker container tracking is wired up yet). `server.provider`
 * is read first so a future Docker-aware server record is honoured without
 * changing this module, but no Docker-specific branch is built out ahead of
 * that data actually existing.
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

// scanFailed distinguishes "the process-detection scan itself could not
// tell" from "it ran fine and found nothing" -- both used to collapse into
// a bare isRunning: false here, which is how a dashboard host badge and a
// destructive-operation guard (server/routes/server.js's /wipe, which reads
// getServerProcessDetails().scanFailed directly) ended up disagreeing about
// the same server: the guard correctly refused on scanFailed, the dashboard
// had nowhere to put that signal and confidently rendered "stopped." When
// scanFailed is true this always wins over isRunning, native/docker
// providers included -- reuses the same "unknown" status remote-sftp
// already renders correctly on the client (ServerStatusBadge.tsx).
export function buildHostSignal(provider, isRunning, scanFailed = false) {
  if (provider === "native") {
    if (scanFailed) {
      return { status: "unknown", label: "Process", detail: "Process detection failed" };
    }
    return { status: isRunning ? "running" : "stopped", label: "Process", detail: null };
  }
  if (provider === "docker-local" || provider === "docker-managed") {
    if (scanFailed) {
      return { status: "unknown", label: "Container", detail: "Process detection failed" };
    }
    return {
      status: isRunning ? "running" : "stopped",
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

export function buildBridgeSignal({ configured, running, modConnected } = {}) {
  if (!configured) return { status: "not-installed", label: "PanelBridge", detail: null };
  const status = running && modConnected ? "active" : "offline";
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
// process state. scanFailed: whether the process-detection scan behind
// isRunning could actually tell (see buildHostSignal). rcon/bridge: plain
// snapshots pulled from the live services by the route handler, so this
// function stays framework-free and testable.
export function composeServerStatus({ server, isRunning, scanFailed, rcon, bridge }) {
  const provider = resolveProvider(server);
  const host = buildHostSignal(provider, isRunning, scanFailed);
  const serverSignal = buildServerSignal(rcon);
  const bridgeSignal = buildBridgeSignal(bridge);
  return {
    provider,
    selected: true,
    host,
    server: serverSignal,
    bridge: bridgeSignal,
    summary: buildSummary(host, serverSignal),
  };
}
