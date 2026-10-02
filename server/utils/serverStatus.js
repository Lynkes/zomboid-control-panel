import { getActiveServer } from "../database/init.js";
import { isHostSignalAuthoritative, resolveProvider } from "./serverStatusModel.js";
import { resolveDockerHostSignal } from "../services/managedContainer.js";
import panelBridge from "../services/panelBridge.js";

/**
 * Determines whether any trustworthy signal proves the active server is up.
 * Process ownership remains necessary for process-control operations.
 */
export function isServerObservedRunning({
  processRunning = false,
  rconConnected = false,
  bridgeConnected = false,
  processScanFailed = false,
  hostStateAuthoritative = false,
} = {}) {
  if (hostStateAuthoritative && !processScanFailed) {
    return Boolean(processRunning);
  }
  if (processScanFailed && !rconConnected && !bridgeConnected) return null;
  return Boolean(processRunning || rconConnected || bridgeConnected);
}

// 2026-09-07 lifecycle-actions hardening: `running` above answers "is
// SOMETHING up" -- for a native/docker-managed host, hostStateAuthoritative
// makes that true the instant the JVM/container process exists, seconds
// after POST /start spawns it, while a real world load can leave RCON
// unreachable for 60-180+ seconds after that (waitForRconAfterStart's own
// comment). Layout.tsx's sidebar dot -- visible on every page -- read that
// raw boolean and went green immediately, so the panel told the operator
// "running" for the exact window where trying to connect would fail. This
// resolves a separate, purely-additive phase for that same moment using the
// SAME signals the route's startup sequence already tracks (rconService's
// serverStarting flag, set right after spawn and cleared by
// waitForRconAfterStart() once it either connects or exhausts its own
// ~5-minute poll -- see server/routes/server.js) instead of adding a new
// clock: 'starting' while host is up, RCON isn't connected yet, and we're
// still inside that window; 'unresponsive' once the window has closed
// (serverStarting cleared, whether by a successful connect or the wait
// exhausting itself) and RCON still never connected -- an honest state that
// answers god's exact guard: "starting forever is the same lie wearing a
// different colour." Both new phases are display-only: `running` above is
// computed exactly as before and nothing gates on this function's result.
export function resolveServerPhase({ running, serverStarting, rconConnected } = {}) {
  if (running === null || running === undefined) return "unknown";
  if (!running) return "stopped";
  if (rconConnected) return "running";
  return serverStarting ? "starting" : "unresponsive";
}

/**
 * The single "is the active server observed running" verdict for whichever
 * server is currently active -- OR-combines the local process scan (or, for
 * docker-local/docker-managed providers, the container's own state instead
 * of the scan, since PZ runs as PID 1 of a *different* container there and
 * the local scan can never see it -- GH#114) with RCON and PanelBridge.
 *
 * 2026-09-01: this used to live ONLY as server/index.js's
 * getObservedServerRunning(), a closure over that module's own
 * serverManager/rconService/dockerClient instances -- which meant it could
 * only ever be called from index.js itself. server/services/discordBot.js
 * answered the identical question ("is the server up") at 6 separate call
 * sites (handleStatus, handlePlayers, handleStart, handleStop,
 * handleRestart, updatePlayerPresence) by reading
 * serverManager.getServerProcessDetails().running ALONE -- no RCON, no
 * bridge, no docker-provider branch -- because discordBot.js cannot import
 * index.js (index.js constructs DiscordBot, so the reverse import would be
 * circular) and had no other way to reach this logic. A split-container
 * deployment (panel and PZ each in their own container, GH#114's shape)
 * made every one of those 6 sites confidently wrong: the scan succeeds and
 * finds nothing (scanFailed: false, running: false) even while RCON is
 * genuinely connected, so Discord reported a confident "Offline" instead of
 * the "unknown" state it already knows how to render, and refused every
 * stop/restart command with "Server is not running" even though RCON could
 * have executed it. Pulled out here -- a leaf module with no import cycle
 * back to either caller -- so index.js's watchdog (checkServerStatusNow),
 * the dashboard badge (routes/serverStatus.js, via the same
 * resolveDockerHostSignal/resolveProvider this function also uses) and
 * discordBot.js all resolve the SAME question the SAME way, and cannot
 * drift out of agreement about the same server at the same moment the way
 * three independent re-implementations eventually would.
 *
 * @param {object} serverManager - the ServerManager instance to scan (must
 *   expose getServerProcessDetails()).
 * @param {{connected: boolean}} rconService - the RconService instance.
 * @param {object} [dockerClient] - explicit Docker client for the
 *   docker-local/docker-managed branch; omit to use managedContainer.js's
 *   shared instance (wired once at startup via setDockerClient()) -- the
 *   only reason index.js still passes its own is to keep this identical to
 *   the pre-refactor call for isServerObservedRunning's own test coverage.
 * @returns {Promise<boolean|null>} true/false, or null for "cannot tell"
 *   (failed scan, no other signal) -- render as unknown, never a confident
 *   "stopped".
 */
export async function resolveObservedServerRunning(serverManager, rconService, dockerClient) {
  const activeServer = await getActiveServer();
  if (activeServer?.isRemote) {
    return isServerObservedRunning({
      processRunning: false,
      rconConnected: rconService?.connected,
      bridgeConnected: panelBridge.isModConnected(),
    });
  }

  const provider = resolveProvider(activeServer);
  if (provider === "docker-local" || provider === "docker-managed") {
    const dockerSignal = await resolveDockerHostSignal(activeServer, dockerClient);
    return isServerObservedRunning({
      processRunning: dockerSignal.running,
      rconConnected: rconService?.connected,
      bridgeConnected: panelBridge.isModConnected(),
      processScanFailed: dockerSignal.scanFailed,
      hostStateAuthoritative: !dockerSignal.scanFailed && isHostSignalAuthoritative(provider),
    });
  }

  const processDetails =
    typeof serverManager?.getServerProcessDetails === "function"
      ? await serverManager.getServerProcessDetails()
      : null;

  return isServerObservedRunning({
    processRunning: processDetails?.running,
    rconConnected: rconService?.connected,
    bridgeConnected: panelBridge.isModConnected(),
    processScanFailed: !processDetails || processDetails.scanFailed,
    hostStateAuthoritative:
      Boolean(processDetails) &&
      !processDetails.scanFailed &&
      isHostSignalAuthoritative("native", activeServer?.lifecycleProvider, processDetails.provider),
  });
}

// When the active server's game process -- for a docker-local/docker-managed
// provider, its container -- started, as { serverId, startedAtMs,
// processKey }, or null whenever that can't be stated with confidence: no
// active server, a remote one, a stopped server, a failed scan, or an OS
// that won't say. Whoever started it: this panel, the service manager after
// a crash (Restart=on-failure), Docker's restart policy, or the operator by
// hand. The mod checker reads it while a mod-update restart waits for
// players to leave (GH #189): a server started again since the update was
// detected has already loaded the updated mods. Same provider split as
// resolveObservedServerRunning() above; the native start time is
// serverManager.resolveStartTime()'s, the one the dashboard's uptime shows.
//
// processKey names the run itself -- the PID (systemd's MainPID, OpenRC's
// child, the scanned or pidfile process), or the container's StartedAt
// string as Docker recorded it -- so "is this still the same run" never
// rests on the clock: a Linux start time is derived from the boot time,
// which moves with every step of the wall clock (a VM or WSL2 resumed from
// sleep, an NTP correction), so the same never-restarted process can read
// as started hours later.
export async function resolveActiveServerStartedAt(serverManager, dockerClient) {
  const activeServer = await getActiveServer();
  if (!activeServer?.id || activeServer.isRemote) return null;

  let startedAtMs = null;
  let processKey = null;
  const provider = resolveProvider(activeServer);
  if (provider === "docker-local" || provider === "docker-managed") {
    const dockerSignal = await resolveDockerHostSignal(activeServer, dockerClient);
    if (dockerSignal.running && !dockerSignal.scanFailed && dockerSignal.startedAt) {
      startedAtMs = Date.parse(dockerSignal.startedAt);
      processKey = `container:${dockerSignal.startedAt}`;
    }
  } else if (
    typeof serverManager?.getServerProcessDetails === "function" &&
    typeof serverManager.resolveStartTime === "function"
  ) {
    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails?.running && !processDetails.scanFailed) {
      const pid = processDetails.mainPid ?? processDetails.matched?.[0]?.pid;
      const startTime = await serverManager.resolveStartTime(processDetails);
      startedAtMs = startTime instanceof Date ? startTime.getTime() : null;
      processKey = pid ? `pid:${pid}` : null;
    }
  }

  return Number.isFinite(startedAtMs) && startedAtMs > 0
    ? { serverId: String(activeServer.id), startedAtMs, processKey }
    : null;
}
