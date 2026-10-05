import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getDataPaths } from "../utils/paths.js";
import { getDiskStatusForPath } from "../services/diskMonitor.js";
import { getCircuitBreakerStatus } from "../database/init.js";
import { getRestartAssessment } from "../services/panelUpdateChecker.js";
import { isContainerized } from "../utils/dockerDetect.js";
import { getRoleByName } from "../services/permissions.js";

const log = createLogger("API:System");
const router = express.Router();

export function buildRuntimeInfo({
  platform = process.platform,
  temporaryDirectory = os.tmpdir(),
  environment = process.env,
  pathSeparator = path.sep,
  fileExists = fs.existsSync,
  restartAssessment = getRestartAssessment({
    platform,
    environment,
  }),
} = {}) {
  const family = platform === "win32"
    ? "windows"
    : ["linux", "darwin", "freebsd", "openbsd", "aix", "sunos"].includes(platform)
      ? "posix"
      : "unknown";

  let serviceManager = "unknown";
  if (environment.INVOCATION_ID || environment.NOTIFY_SOCKET) {
    serviceManager = "systemd";
  } else if (environment.RC_SVCNAME) {
    serviceManager = "openrc";
  } else {
    try {
      if (isContainerized(fileExists)) {
        serviceManager = "container";
      } else if (family === "windows" || platform === "darwin") {
        serviceManager = "none";
      }
    } catch {
      // A neutral value is safer than claiming a service manager.
    }
  }

  return {
    platform,
    family,
    pathSeparator,
    temporaryDirectory,
    serviceManager,
    restartAssessment,
  };
}

// No requireRole, deliberately: this is the disk-space/storage-health
// warning the frontend polls dashboard-wide, so every role sees a full
// disk coming before it becomes their problem. Read-only, and error
// messages already run through sanitizeError before leaving this file.

// The folders behind those readings (the save volume and the panel's data
// folder) go only to roles that can act on a full disk -- the same ones
// index.js sends the disk:* events to (DISK_EVENT_CAPABILITIES). Every
// other role gets the readings with `path: null`, which the banner never
// reads (security sweep 2026-10-04, adversary pass: the disk:* events were
// scoped, but these two routes still sent the paths to every role).
const DISK_PATH_CAPABILITIES = ["diagnostics.manage", "backups.manage"];

// Fails closed: a role that can't be resolved holds none of them.
async function roleHasAnyCapability(user, required) {
  if (!user) return false;
  try {
    const role = await getRoleByName(user.role);
    const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
    return required.some((capability) => capabilities.includes(capability));
  } catch {
    return false;
  }
}

function canSeeDiskPaths(user) {
  return roleHasAnyCapability(user, DISK_PATH_CAPABILITIES);
}

// SECURITY (2026-10-05, H4): GET /runtime is read by every role's pages
// (platform-specific wording), and it returned the host's temp folder --
// os.tmpdir(), which names the account the panel runs as on Windows
// (C:\Users\<name>\AppData\Local\Temp). Its one reader is the panel-update
// confirmation, as the fallback for where the update helper writes its log;
// the update preflight (panel.settings) already sends that folder itself.
// So it goes to the roles that see host details elsewhere -- diagnostics
// (which downloads the panel's logs and moves its folders) and panel
// settings (the update flow) -- and is null for everyone else, the way the
// disk routes above send path: null.
const RUNTIME_PATH_CAPABILITIES = ["diagnostics.manage", "panel.settings"];

function withoutPath(status) {
  return status && typeof status === "object" ? { ...status, path: null } : status;
}

// Combined disk status for both the save volume (polled by DiskMonitor) and
// the panel's own data directory (checked fresh — it's cheap, and its
// disk isn't necessarily the same mount as the save volume).
async function buildDiskSpace(req) {
  const diskMonitor = req.app.get("diskMonitor");
  const saveVolume = diskMonitor ? diskMonitor.getDiskStatus() : null;
  const panelData = await getDiskStatusForPath(getDataPaths().dataDir);
  if (await canSeeDiskPaths(req.user)) return { saveVolume, panelData };
  return { saveVolume: withoutPath(saveVolume), panelData: withoutPath(panelData) };
}

router.get("/disk-space", async (req, res) => {
  try {
    res.json(await buildDiskSpace(req));
  } catch (error) {
    log.error(`Failed to get disk space: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/runtime", async (req, res) => {
  const runtime = buildRuntimeInfo();
  if (await roleHasAnyCapability(req.user, RUNTIME_PATH_CAPABILITIES)) return res.json(runtime);
  res.json({ ...runtime, temporaryDirectory: null });
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
