import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getDataPaths } from "../utils/paths.js";
import { getDiskStatusForPath } from "../services/diskMonitor.js";
import { getCircuitBreakerStatus } from "../database/init.js";

const log = createLogger("API:System");
const router = express.Router();

// Combined disk status for both the save volume (polled by DiskMonitor) and
// the panel's own data directory (checked fresh — it's cheap, and its
// disk isn't necessarily the same mount as the save volume).
async function buildDiskSpace(req) {
  const diskMonitor = req.app.get("diskMonitor");
  const saveVolume = diskMonitor ? diskMonitor.getDiskStatus() : null;
  const panelData = await getDiskStatusForPath(getDataPaths().dataDir);
  return { saveVolume, panelData };
}

router.get("/disk-space", async (req, res) => {
  try {
    res.json(await buildDiskSpace(req));
  } catch (error) {
    log.error(`Failed to get disk space: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Single endpoint the frontend polls: disk space + write circuit breaker
// state, so the UI can warn before a full disk silently drops writes.
router.get("/storage-health", async (req, res) => {
  try {
    const diskSpace = await buildDiskSpace(req);
    const circuitBreaker = getCircuitBreakerStatus();
    res.json({
      diskSpace,
      circuitBreaker: {
        ...circuitBreaker,
        lastError: circuitBreaker.lastError
          ? sanitizeError(circuitBreaker.lastError)
          : null,
      },
    });
  } catch (error) {
    log.error(`Failed to get storage health: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
