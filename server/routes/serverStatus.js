// Composed, provider-aware status for the active server: host (process /
// container / remote reachability), RCON, and PanelBridge as three
// independent signals instead of one ambiguous "running" flag. See
// server/utils/serverStatusModel.js for the composition logic.
import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getActiveServer } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";
import { composeServerStatus, resolveProvider } from "../utils/serverStatusModel.js";
import { resolveDockerHostSignal } from "../services/managedContainer.js";

const log = createLogger("API:ServerStatus");
const router = express.Router();

// No requireRole, deliberately: every role needs to know whether the
// server is up before doing anything else with it (a moderator deciding
// whether to even attempt an in-game action, a technician deciding whether
// to restart it). Read-only, nothing sensitive returned.
router.get("/active/status", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const rconConfig = rconService?.getConfig ? rconService.getConfig() : {};

    const provider = resolveProvider(server);
    const isContainerProvider =
      provider === "docker-local" || provider === "docker-managed";

    // A fresh check, not serverManager.isRunning -- that cached field is
    // forced to a confident `false` by ANY failed process-detection scan,
    // so reading it directly here made this endpoint (which feeds the
    // dashboard's host badge) disagree with /wipe's own fresh scanFailed
    // check on the exact same host, at the exact same moment. See
    // server/utils/serverStatusModel.js's buildHostSignal for how scanFailed
    // renders as "unknown" instead of a wrong "stopped".
    let processDetails;
    let dockerContainer = null;
    if (isContainerProvider) {
      const dockerClient = req.app.get("dockerClient");
      // resolveDockerHostSignal is also what the status watchdog
      // (server/index.js's getObservedServerRunning) calls for these same
      // two providers -- one implementation so this route's dashboard
      // badge and the watchdog's push-on-transition emit can never disagree
      // about what "Docker says running" means for the same server at the
      // same moment.
      const dockerSignal = await resolveDockerHostSignal(server, dockerClient);
      processDetails = dockerSignal;
      dockerContainer = dockerSignal.scanFailed
        ? { handled: true, error: "Docker container status unavailable" }
        : { handled: true, running: dockerSignal.running, startedAt: dockerSignal.startedAt };
    } else {
      processDetails = typeof serverManager?.getServerProcessDetails === "function"
        ? await serverManager.getServerProcessDetails()
        : { running: !!serverManager?.isRunning, scanFailed: false };
    }

    // The native process's start time, from the OS for the process the
    // check above just found (see ServerManager.resolveStartTime()). Only
    // asked for a native server: a remote-sftp profile's local scan says
    // nothing about the remote host, and a container provider's start time
    // comes from Docker instead.
    const startedAt =
      provider === "native" &&
      processDetails.running &&
      !processDetails.scanFailed &&
      typeof serverManager?.resolveStartTime === "function"
        ? await serverManager.resolveStartTime(processDetails)
        : null;

    // GH#114: PZ in this provider runs as PID 1 of a *different* container,
    // so the local process scan above can never see it -- it's asked for
    // regardless (serverManager still needs it for native servers) but for
    // docker-local/docker-managed the host signal must come from the
    // managed container's own state instead, never the scan. See
    // buildHostSignal in serverStatusModel.js for the fail-closed handling
    // when Docker control is disabled/unavailable or the mapping is broken.
    const status = composeServerStatus({
      server,
      isRunning: !!processDetails.running,
      scanFailed: !!processDetails.scanFailed,
      dockerContainer,
      // round 28 (ux-proposals-need-backend-data): native-only, set by
      // server/index.js's classifyStopReason() the moment the watchdog
      // observes running:true -> false. See serverStatusModel.js's own
      // describeStopReason for how this renders.
      stopReason: serverManager?.lastStopReason,
      startedAt,
      // "systemd"/"openrc" when a managed unit's own state answered rather
      // than the plain scan -- see isHostSignalAuthoritative's answeredBy.
      hostAnsweredBy: processDetails.provider,
      rcon: {
        ...rconConfig,
        connecting: !!(rconService?.connecting || rconService?.reconnecting),
      },
      bridge: {
        configured: !!panelBridge.bridgePath,
        running: !!panelBridge.isRunning,
        modConnected: panelBridge.isModConnected ? panelBridge.isModConnected() : false,
        // How old the mod's last status.json write is, against the normal
        // (not idle-stretched) freshness window: once the host confirms the
        // process gone, only a heartbeat inside that window still counts --
        // see buildBridgeSignal.
        heartbeatAgeMs: panelBridge.modStatus?.age ?? null,
        heartbeatFreshMs: panelBridge.config?.statusStaleMs ?? null,
      },
    });

    // serverTime: this host's clock as it answered. host.startedAt is read
    // off the host's (or Docker's) clock while the client counts uptime on
    // its own, so the client shifts it by (its receipt time - serverTime)
    // to keep any skew between the two out of the displayed uptime.
    res.json({ ...status, serverTime: Date.now() });
  } catch (error) {
    log.error(`Failed to get composed server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
