/**
 * GET/POST /api/panel-bridge/delivery -- how PanelBridge reaches the ACTIVE
 * server (panel-installed or Steam Workshop), and switching between the two.
 * Shapes are the contract in client/src/lib/bridgeDeliveryTypes.ts; every
 * field is computed server-side (services/bridgeDelivery.js) so the client
 * only maps states to copy.
 *
 * Mounted in index.js ABOVE the /api/panel-bridge router so this path is
 * never shadowed by it. There are no socket events of its own: the client
 * refetches on the existing panelBridge:modStatus and server:status events.
 */
import express from "express";
import path from "path";
import bridge from "../services/panelBridge.js";
import { getActiveServer } from "../database/init.js";
import { requireAnyPermission, requirePermission } from "../services/permissions.js";
import { hostPathViewFor } from "../utils/hostPathView.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import {
  DeliveryError,
  applyDeliverySwitch,
  getDeliveryStatus,
  planDeliverySwitch,
} from "../services/bridgeDelivery.js";
import { DELIVERY_METHODS } from "../services/bridgeDeliveryContract.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("API:BridgeDelivery");
const router = express.Router();

function deliveryDeps(req) {
  return {
    serverManager: req.app?.get?.("serverManager"),
    rconService: req.app?.get?.("rconService"),
    modChecker: req.app?.get?.("modChecker"),
    // A Docker server's start time (see resolveGameStartMs()); undefined
    // falls back to managedContainer.js's shared client.
    dockerClient: req.app?.get?.("dockerClient"),
    bridge,
  };
}

function noActiveServer(res) {
  return res.status(400).json({
    error: "No active server configured.",
    code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
  });
}

function notActiveServer(res) {
  return res.status(409).json({
    error: "The active server changed. Reload this page and try again.",
    code: ErrorCode.PANELBRIDGE_DELIVERY_NOT_ACTIVE_SERVER,
  });
}

function invalidMethod(res) {
  return res.status(400).json({
    error: 'PanelBridge delivery must be "local" or "workshop".',
    code: ErrorCode.PANELBRIDGE_DELIVERY_METHOD_INVALID,
  });
}

function sendDeliveryError(res, error) {
  if (error instanceof DeliveryError) {
    return res.status(error.status).json({
      error: sanitizeError(error.message),
      ...(error.code ? { code: error.code } : {}),
      ...(error.params ? { params: sanitizeErrorParams(error.params) } : {}),
      ...(error.status >= 500 ? { restored: error.restored !== false } : {}),
    });
  }
  log.error(`PanelBridge delivery request failed: ${error.message}`);
  return res.status(500).json({ error: sanitizeError(error.message) });
}

// Read by every role that has a reason to look at how the bridge is set up:
// Settings (bridge.setup / bridge.diagnostics), Server Config's
// DoLuaChecksum note (serverfiles.manage) and the Mods page's managed-entry
// badge (mods.manage).
router.get(
  "/",
  requireAnyPermission("bridge.setup", "bridge.diagnostics", "serverfiles.manage", "mods.manage"),
  async (req, res) => {
    try {
      const active = await getActiveServer();
      if (!active) return noActiveServer(res);
      const requested = req.query?.serverId;
      if (requested !== undefined && requested !== "" && String(requested) !== String(active.id)) {
        return notActiveServer(res);
      }
      res.json(
        deliveryStatusView(await getDeliveryStatus(active, deliveryDeps(req)), await hostPathViewFor(req.user)),
      );
    } catch (error) {
      sendDeliveryError(res, error);
    }
  },
);

// SECURITY (2026-10-05, H4 round 3): of the four capabilities above, only
// bridge.setup sets folders up; a custom role holding only one of the other
// three got the placeholder for the install folder from GET /api/servers
// and the folder itself here. Such a role (utils/hostPathView.js) gets the
// install and Workshop item folders as the placeholder, the ini by name and
// each loose bridge file below the install folder (as the page shows them
// anyway), and every other string -- the start failure's console line --
// path-redacted.
export function deliveryStatusView(status, view) {
  if (view.full || !status || typeof status !== "object") return status;
  const disk = status.disk;
  if (!disk || typeof disk !== "object") return view.deep(status);
  const installDir = typeof disk.installDir === "string" ? disk.installDir : null;
  const belowInstall = (file) => {
    if (typeof file !== "string" || !installDir) return view.file(file);
    const relative = path.relative(installDir, file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : view.file(file);
  };
  return view.deep({
    ...status,
    disk: {
      ...disk,
      installDir: view.folder(disk.installDir),
      iniPath: view.file(disk.iniPath),
      looseFiles: Array.isArray(disk.looseFiles)
        ? disk.looseFiles.map((file) => ({ ...file, path: belowInstall(file?.path) }))
        : disk.looseFiles,
      workshopItem:
        disk.workshopItem && typeof disk.workshopItem === "object"
          ? { ...disk.workshopItem, folder: view.folder(disk.workshopItem.folder) }
          : disk.workshopItem,
    },
  });
}

// dryRun (the default) previews the exact steps; dryRun:false applies them
// under the global lifecycle lock, so a switch never overlaps a start,
// stop, restart or update of any server. Starting or restarting afterwards
// is the client's own, separate call -- never a hidden chain here.
router.post("/", requirePermission("bridge.setup"), async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const { serverId, method, expectedFrom } = body;
  const apply = body.dryRun === false;
  let lock = null;
  try {
    const active = await getActiveServer();
    if (!active) return noActiveServer(res);
    if (serverId === undefined || serverId === null || String(serverId) !== String(active.id)) {
      return notActiveServer(res);
    }
    if (!DELIVERY_METHODS.includes(method)) return invalidMethod(res);

    if (!apply) {
      return res.json(await planDeliverySwitch(active, method, deliveryDeps(req)));
    }

    if (!DELIVERY_METHODS.includes(expectedFrom)) return invalidMethod(res);
    lock = acquireLifecycleLock("bridge-delivery-switch", active.id);
    if (!lock) return res.status(409).json(lifecycleInProgressResponse());
    const result = await applyDeliverySwitch(active, method, {
      expectedFrom,
      actor: req.user?.username || null,
      deps: deliveryDeps(req),
    });
    res.json(result);
  } catch (error) {
    sendDeliveryError(res, error);
  } finally {
    lock?.release();
  }
});

export default router;
