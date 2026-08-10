// Composed, provider-aware status for the active server: host (process /
// container / remote reachability), RCON, and PanelBridge as three
// independent signals instead of one ambiguous "running" flag. See
// server/utils/serverStatusModel.js for the composition logic.
import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getActiveServer } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";
import { composeServerStatus } from "../utils/serverStatusModel.js";

const log = createLogger("API:ServerStatus");
const router = express.Router();

router.get("/active/status", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const rconConfig = rconService?.getConfig ? rconService.getConfig() : {};

    const status = composeServerStatus({
      server,
      isRunning: !!serverManager?.isRunning,
      rcon: {
        ...rconConfig,
        connecting: !!(rconService?.connecting || rconService?.reconnecting),
      },
      bridge: {
        configured: !!panelBridge.bridgePath,
        running: !!panelBridge.isRunning,
        modConnected: panelBridge.isModConnected ? panelBridge.isModConnected() : false,
      },
    });

    res.json(status);
  } catch (error) {
    log.error(`Failed to get composed server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
