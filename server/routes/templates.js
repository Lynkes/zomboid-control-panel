import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { requirePermission } from "../services/permissions.js";
import { getActiveServer } from "../database/init.js";
import {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  exportTemplate,
  importTemplate,
  previewTemplate,
  applyTemplate,
} from "../services/templateService.js";

const log = createLogger("API:Templates");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    res.json({ templates: await listTemplates() });
  } catch (error) {
    log.error(`Failed to list templates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const template = await getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json({ template });
  } catch (error) {
    log.error(`Failed to get template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await saveTemplate(req.body);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (error) {
    log.error(`Failed to create template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/import", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await importTemplate(req.body?.template ?? req.body);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (error) {
    log.error(`Failed to import template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:id/export", async (req, res) => {
  try {
    const result = await exportTemplate(req.params.id);
    if (!result.success) return res.status(404).json({ error: result.error });
    res
      .set("Content-Disposition", `attachment; filename="${req.params.id}.json"`)
      .json(result.template);
  } catch (error) {
    log.error(`Failed to export template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/preview", async (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!serverId) return res.status(400).json({ error: "serverId is required" });

    const result = await previewTemplate(req.params.id, serverId);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (error) {
    log.error(`Failed to preview template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/apply", requirePermission("templates.manage"), async (req, res) => {
  try {
    const { serverId, options } = req.body || {};
    if (!serverId) return res.status(400).json({ error: "serverId is required" });

    const activeServer = await getActiveServer();
    if (String(activeServer?.id) === String(serverId)) {
      const serverManager = req.app.get("serverManager");
      if (!serverManager?.getServerProcessDetails) {
        return res.status(503).json({
          error: "Unable to verify server state",
        });
      }
      try {
        // getServerProcessDetails(), not checkServerRunning() -- the latter
        // discards the scan's own scanFailed flag and returns a plain
        // boolean, so a scan that completed but couldn't determine the
        // server's state (timeout, PowerShell/exec error) came back
        // indistinguishable from "confirmed stopped" and let this apply
        // proceed. Same fail-open class already fixed at /wipe,
        // /delete-files, chunks.js's delete-chunks/delete-region, and
        // backup.js's restore.
        const details = await serverManager.getServerProcessDetails();
        if (details.scanFailed) {
          return res.status(503).json({
            error: "Unable to verify server state",
          });
        }
        if (details.running) {
          return res.status(409).json({
            error: "Stop the server before applying a template",
          });
        }
      } catch (error) {
        log.warn(`Could not verify server state before template apply: ${error.message}`);
        return res.status(503).json({
          error: "Unable to verify server state",
        });
      }
    } else {
      // Fail closed, not open. This branch used to be nothing -- the whole
      // running-state guard above only exists inside the "target IS the
      // active server" arm, so applying to any OTHER configured server
      // skipped it entirely. serverManager is bound to one server by name
      // and has no way to probe a different, non-active server's process
      // state, so there's no check to run here -- but "can't check" must
      // fail the same way it does everywhere else in this codebase, not be
      // read as "must be stopped." A normal two-profile workflow (server A
      // running and active, template applied to configured-but-inactive
      // server B) would otherwise silently overwrite B's live .ini while
      // its own process holds the file open. Real cross-server process
      // detection is a separate feature; refusing is the fix for tonight.
      // See 2026-08-24 conv-template-privesc.
      return res.status(409).json({
        error:
          "Can't verify this server's running state — the panel can only check the currently active server. Switch to this server first, then apply the template.",
      });
    }

    const result = await applyTemplate(req.params.id, serverId, options || {});
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to apply template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/:id", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (error) {
    log.error(`Failed to delete template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
