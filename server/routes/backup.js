import express from "express";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { getActiveServer } from "../database/init.js";
import { requirePermission } from "../services/permissions.js";
import { listBackupRecords } from "../services/backupRecords.js";
import { ErrorCode } from "../utils/errorCodes.js";
const log = createLogger("API:Backup");

const router = express.Router();

// Get backup status and settings
router.get("/status", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const status = await backupService.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get backup status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get info about what backups contain
router.get("/info", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const info = backupService.getBackupContentsInfo();
    res.json(info);
  } catch (error) {
    log.error(`Failed to get backup info: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get list of backups
router.get("/list", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backups = await backupService.listBackups();
    res.json({ backups });
  } catch (error) {
    log.error(`Failed to list backups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/history", async (req, res) => {
  try {
    const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;
    const records = await listBackupRecords({
      serverId: req.query.serverId,
      limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : undefined,
    });
    res.json({ records });
  } catch (error) {
    log.error(`Failed to list backup history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:name/snapshot", requirePermission("backups.manage"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const result = await backupService.getBackupSnapshot(req.params.name);
    if (result.success) return res.json(result);
    return res.status(404).json(result);
  } catch (error) {
    log.error(`Failed to read backup snapshot: ${error.message}`);
    return res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update backup settings
router.post("/settings", requirePermission("backups.manage"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const scheduler = req.app.get("scheduler");

    // Whitelist allowed backup settings to prevent prototype pollution
    const allowed = {};
    if (req.body.enabled !== undefined) allowed.enabled = !!req.body.enabled;
    if (req.body.schedule !== undefined)
      allowed.schedule = String(req.body.schedule);
    if (req.body.maxBackups !== undefined) {
      const parsed = parseInt(req.body.maxBackups, 10);
      allowed.maxBackups = isNaN(parsed)
        ? 5
        : Math.min(Math.max(parsed, 1), 100);
    }
    if (req.body.includeDb !== undefined)
      allowed.includeDb = !!req.body.includeDb;

    const settings = await backupService.updateSettings(allowed);

    // Update scheduler with new backup settings
    if (scheduler && scheduler.setupBackupSchedule) {
      await scheduler.setupBackupSchedule();
    }

    res.json({ success: true, settings });
  } catch (error) {
    log.error(`Failed to update backup settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create a manual backup
router.post("/create", requirePermission("backups.manage"), async (req, res) => {
  try {
    log.info("POST /create — creating manual backup");
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Backups are not available for remote servers. The server filesystem is not accessible from this panel.",
          code: ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE,
        });
    }

    const backupService = req.app.get("backupService");
    const io = req.app.get("io");

    // Pass io for progress updates
    const result = await backupService.createBackup({ ...req.body, io });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to create backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a backup
router.delete("/:name", requirePermission("backups.manage"), async (req, res) => {
  try {
    log.info(`DELETE /${req.params.name}`);
    const backupService = req.app.get("backupService");
    const result = await backupService.deleteBackup(req.params.name);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to delete backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Download a backup archive off the machine. Its own capability, not
// folded into backups.manage: creating, deleting or restoring a backup
// manipulates data on this machine, but downloading EXFILTRATES a full
// copy of it -- world save data, and if includeDb was ever turned on,
// db.json's bcrypt password hashes too. A role trusted to manage backups
// day-to-day is not automatically a role that should be able to walk
// away with an offline copy of everything.
// /list and /history stay deliberately ungated (read-only status routes
// are outside the matrix on purpose), but that pair is what makes this
// exposure trivially reachable without the gate below: enumerate the
// filenames, then download.
router.get("/download/:name", requirePermission("backups.download"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backupsPath = await backupService.getBackupsPath();

    if (!backupsPath) {
      return res.status(404).json({ error: "Backups folder not found", code: ErrorCode.BACKUPS_FOLDER_NOT_FOUND });
    }

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(req.params.name);
    if (!safeName.endsWith(".zip")) {
      return res.status(400).json({ error: "Invalid backup file", code: ErrorCode.BACKUP_INVALID_FILE });
    }

    const backupPath = path.join(backupsPath, safeName);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: "Backup not found", code: ErrorCode.BACKUP_NOT_FOUND });
    }

    res.download(backupPath, safeName);
  } catch (error) {
    log.error(`Failed to download backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Restore a backup. Admin-only, deliberately narrower than the other backup
// routes: deleting a backup destroys the operator's safety net (housekeeping),
// but restoring one rolls the live world back over every player currently
// standing in it -- a decision about other people's time, not routine server
// operation, and invisible to the admin until someone complains.
router.post("/restore/:name", requirePermission("backups.restore"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Backup restore is not available for remote servers. The server filesystem is not accessible from this panel.",
          code: ErrorCode.BACKUP_RESTORE_REMOTE_NOT_AVAILABLE,
        });
    }

    const backupService = req.app.get("backupService");
    const serverManager = req.app.get("serverManager");

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(req.params.name);
    if (!safeName.endsWith(".zip")) {
      return res.status(400).json({ error: "Invalid backup file", code: ErrorCode.BACKUP_INVALID_FILE });
    }

    // Check if server is running. checkServerRunning() collapses a FAILED
    // detection scan into a plain `false` -- indistinguishable from a
    // confirmed-stopped server -- which would let this restore silently
    // overwrite the live world save while the server might still be running
    // and holding those files open. getServerProcessDetails() exposes that
    // distinction via scanFailed, so use it directly and fail closed when
    // detection itself failed, same as /wipe, /delete-files and
    // chunks.js's delete-chunks/delete-region.
    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        success: false,
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (processDetails.running) {
      return res.status(400).json({
        success: false,
        error:
          "Server must be stopped before restoring a backup. Please stop the server first.",
        code: ErrorCode.BACKUP_RESTORE_SERVER_RUNNING,
      });
    }

    const io = req.app.get("io");
    // Pass io for progress updates -- see createBackup's identical pattern above.
    const result = await backupService.restoreBackup(safeName, { ...req.body, io });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to restore backup: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete backups older than X days
router.post("/delete-older-than", requirePermission("backups.manage"), async (req, res) => {
  try {
    const { days } = req.body;

    if (typeof days !== "number" || days < 1) {
      return res
        .status(400)
        .json({ error: "Invalid days parameter. Must be a number >= 1", code: ErrorCode.BACKUP_INVALID_DAYS_PARAMETER });
    }

    const backupService = req.app.get("backupService");
    const result = await backupService.deleteBackupsOlderThan(days);

    res.json(result);
  } catch (error) {
    log.error(`Failed to delete old backups: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Upload a backup .zip from the user's machine into the backups folder.
// The body is the raw zip bytes; the filename is read from the
// X-Backup-Filename header. The stored filename is prefixed with
// "uploaded-" so external archives are visually separated from the
// panel's own scheduled backups, and never collide with them when the
// auto-prune logic looks for the oldest panel-created backup to drop.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB ceiling
router.post(
  "/upload",
  requirePermission("backups.manage"),
  express.raw({ type: "application/zip", limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    try {
      const activeServer = await getActiveServer();
      if (activeServer?.isRemote) {
        return res
          .status(400)
          .json({
            error: "Backup upload is not available for remote servers.",
            code: ErrorCode.BACKUP_UPLOAD_REMOTE_NOT_AVAILABLE,
          });
      }

      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res
          .status(400)
          .json({
            error:
              "No file uploaded. Send the zip body with Content-Type: application/zip.",
            code: ErrorCode.BACKUP_UPLOAD_NO_FILE,
          });
      }

      // Quick sanity check: zip files start with the local-file-header
      // signature 0x504B0304 ("PK\x03\x04"). Catches accidental uploads
      // of completely different file types early.
      if (req.body.length < 4 || req.body[0] !== 0x50 || req.body[1] !== 0x4b) {
        return res
          .status(400)
          .json({ error: "File does not look like a valid .zip archive.", code: ErrorCode.BACKUP_UPLOAD_INVALID_ZIP_SIGNATURE });
      }

      const rawName = String(
        req.headers["x-backup-filename"] || "uploaded-backup.zip",
      );
      // Strip any path components and limit to filesystem-safe characters.
      // path.basename() handles both / and \ separators on all platforms.
      const baseName = path
        .basename(rawName)
        .replace(/[^A-Za-z0-9_.\- ]/g, "_")
        .slice(0, 200);
      if (!baseName.toLowerCase().endsWith(".zip")) {
        return res
          .status(400)
          .json({ error: "Only .zip backups are accepted.", code: ErrorCode.BACKUP_UPLOAD_INVALID_EXTENSION });
      }

      const backupService = req.app.get("backupService");
      const backupsPath = await backupService.getBackupsPath();
      if (!backupsPath) {
        return res
          .status(500)
          .json({
            error: "Backups folder not available. Configure the server first.",
            code: ErrorCode.BACKUPS_FOLDER_UNAVAILABLE,
          });
      }
      if (!fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }

      // Always prefix to distinguish from auto-named backups (world_backup_*).
      const finalName = baseName.startsWith("uploaded-")
        ? baseName
        : `uploaded-${baseName}`;
      const targetPath = path.join(backupsPath, finalName);

      // Refuse silent overwrite — a user would lose the previous upload.
      if (fs.existsSync(targetPath)) {
        return res
          .status(409)
          .json({
            error: `A backup named "${finalName}" already exists. Delete it first or rename the upload.`,
            code: ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT,
            params: sanitizeErrorParams({ name: finalName }),
          });
      }

      // Atomic write: write to .tmp first, then rename. A crash during
      // upload won't leave a half-written .zip in the listing.
      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, req.body);
      fs.renameSync(tmpPath, targetPath);

      log.info(`POST /upload — stored ${finalName} (${req.body.length} bytes)`);
      res.json({
        success: true,
        name: finalName,
        size: req.body.length,
        message: `Uploaded backup saved as ${finalName}. Use Restore to apply it.`,
      });
    } catch (error) {
      log.error(`Failed to upload backup: ${error.message}`);
      res.status(500).json({ error: sanitizeError(error.message) });
    }
  },
);

export default router;
