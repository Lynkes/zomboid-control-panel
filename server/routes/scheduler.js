import express from 'express';
import cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Scheduler');
import { sanitizeError } from '../utils/sanitize.js';
import {
  getScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  getScheduleHistory,
  clearScheduleHistory,
  getActiveServer,
  getServer
} from '../database/init.js';
import { requirePermission } from '../services/permissions.js';
import { classifyScheduledCommand } from '../services/scheduler.js';

const router = express.Router();

// Task automation (create/edit/delete/run scheduled commands, trigger an
// immediate restart) is "operate the server" — technician's job per the
// role brief, not player-facing, so moderator is excluded. Applied once at
// the router level rather than per-route. Previously any logged-in role,
// including moderator, could create or run a scheduled task — including
// /restart-now.
router.use(requirePermission('automation.manage'));

// automation.manage alone only covers the curated, validated verbs
// classifyScheduledCommand() recognises (restart/save/servermsg/bridge:).
// Anything else is a RAW RCON command — the exact power routes/rcon.js
// gates behind rcon.execute, admin+technician only, deliberately not
// moderator. Without this, a role built with only automation.manage (a
// real, supported thing to do via Roles & Permissions — its own label,
// "manage scheduled tasks", says nothing about RCON) could create a task
// with any RCON command and either wait for it to fire or "Run now" it
// immediately, shutting the server down or banning anyone, invisibly
// (the scheduled-task fallback in services/scheduler.js runs with
// skipLog:true, so it never appears in RCON history). See
// docs/qa/kevin-adversarial-findings.md Finding 1.
//
// A cron fire has no request and no req.user, so the gate can't live at
// execution time for the unattended case — it has to live at the only
// moments a raw command can actually enter the system with a real,
// checkable identity behind the request: creating/editing a task (below),
// and manually triggering one via "Run now" (also request-bound, checked
// separately at that route). Reuses requirePermission() itself rather than
// re-deriving the role/capability lookup — same fail-closed behaviour,
// same error shape, zero risk of drifting from what the middleware form
// does. If requirePermission finds the caller lacks the capability it
// sends the 403/401 response itself; the caller here just needs to know
// whether to stop.
async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

// node-cron (this app's cron engine) accepts an optional LEADING seconds
// field -- 6 space-separated fields instead of 5 -- which nothing in this
// app documents, exposes, or needs: the UI's format hint and every preset
// are 5-field ("minute hour day month weekday", see
// client/src/locales/en/scheduler.json's cronFormatHint/customExpressionPlaceholder),
// but the free-text custom-expression input (Scheduler.tsx) accepts
// anything cron.validate() accepts, including 6 fields. isCronTooFrequent()
// below was built to analyse a 5-field expression and always reads parts[0]
// as MINUTES -- for a 6-field expression parts[0] is actually SECONDS, so
// e.g. "*/5 * * * * *" (fires every 5 SECONDS) reads as minute="*/5", which
// looks like a harmless once-every-5-minutes value and sails through the
// DoS guard untouched. The bypass window is narrower than "any 6-field
// expression": "* * * * * *" and "*/1"-"*/4" seconds are caught BY ACCIDENT
// (parts[0] still matches the every-minute checks below), which is exactly
// why this survived -- spot-checking with the obvious "every second" case
// would have shown the guard working. What sails through is "*/5" to
// "*/59" seconds, which look like ordinary sub-5-minute-safe minute values.
// Reject outright rather than teaching the guard a second field grammar
// for a feature this app has never exposed or tested.
export function hasUnsupportedCronFieldCount(expr) {
  return expr.trim().split(/\s+/).length !== 5;
}

/**
 * Check if a cron expression runs more frequently than every 5 minutes.
 * Parses the minute and hour fields to detect sub-5-minute intervals.
 * Assumes a 5-field expression -- callers must reject anything else via
 * hasUnsupportedCronFieldCount() first (both scheduler.js routes do). The
 * arity check below is defense-in-depth for any other caller, not the
 * primary gate: treats anything but exactly 5 fields as too-frequent-to-be-
 * safe (fail closed) rather than silently misreading a field it was never
 * built to parse.
 */
function isCronTooFrequent(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return true;
  const [minute, hour] = parts;

  // Every minute: * or */1 through */4 (also catches range-step forms like 0-59/2)
  if (minute === '*') return true;
  if (/^\*\/([1-4])$/.test(minute)) return true;

  // Range with step: e.g. "1-59/2" or "0-30/1" — bypasses the */N check.
  // Reject any range step <5, regardless of the range bounds.
  const rangeStep = minute.match(/^\d+-\d+\/(\d+)$/);
  if (rangeStep) {
    const step = parseInt(rangeStep[1], 10);
    if (Number.isFinite(step) && step >= 1 && step < 5) return true;
  }

  // Comma-separated minutes — reject if any two consecutive runs are <5 min apart.
  // Within-hour gaps fire whenever the cron runs, regardless of the hour field
  // (e.g. `0,1,2 0 * * *` still produces 1-minute gaps at midnight). Previously
  // this branch was gated on `hour === '*'` which let hour-pinned bursts slip
  // through the throttle.
  if (minute.includes(',')) {
    const values = minute
      .split(',')
      .map(v => parseInt(v.trim(), 10))
      .filter(n => Number.isFinite(n) && n >= 0 && n <= 59)
      .sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) {
      if (values[i] - values[i - 1] < 5) return true;
    }
    // Wrap-around (last of hour N → first of hour N+1) only matters when
    // consecutive hours fire. Conservatively gate this on hour === '*'.
    if (hour === '*' && values.length >= 2) {
      const wrap = (60 - values[values.length - 1]) + values[0];
      if (wrap < 5) return true;
    }
  }

  return false;
}

// Get scheduler status
router.get('/status', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const status = scheduler.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get scheduler status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get all scheduled tasks
router.get('/tasks', async (req, res) => {
  try {
    const tasks = await getScheduledTasks();
    res.json({ tasks });
  } catch (error) {
    log.error(`Failed to get scheduled tasks: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Validate cron expression
router.post('/validate-cron', async (req, res) => {
  try {
    const { cronExpression } = req.body;
    if (!cronExpression) {
      return res.status(400).json({ valid: false, error: 'cronExpression is required' });
    }

    const isValid = cron.validate(cronExpression);
    if (!isValid) {
      return res.json({ valid: false, error: 'Invalid cron expression format' });
    }

    // Keep this preview endpoint's verdict consistent with what POST /tasks
    // and PUT /tasks/:id will actually accept -- without this, a 6-field
    // expression previews as valid here and then gets refused on submit.
    if (hasUnsupportedCronFieldCount(cronExpression)) {
      return res.json({
        valid: false,
        error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday.',
      });
    }

    res.json({ valid: true });
  } catch (error) {
    res.status(500).json({ valid: false, error: sanitizeError(error.message) });
  }
});

// Create a new scheduled task
router.post('/tasks', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { name, cronExpression, command, serverId } = req.body;
    log.info(`POST /tasks: name=${name}, cron=${cronExpression}, command=${(command || '').substring(0, 80)}, serverId=${serverId}`);

    if (!name || !cronExpression || !command) {
      return res.status(400).json({ error: 'Name, cronExpression, and command are required' });
    }

    // Validate input types and lengths
    if (typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'Invalid task name (max 100 chars)' });
    }
    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 chars)' });
    }
    if (typeof cronExpression !== 'string' || cronExpression.length > 100) {
      return res.status(400).json({ error: 'Invalid cron expression format' });
    }

    // A raw (non restart/save/servermsg/bridge:) command reaches RCON with
    // the same power as rcon.execute's own console -- require it explicitly
    // rather than letting automation.manage alone grant that silently.
    if (classifyScheduledCommand(command) === 'raw') {
      const allowed = await requireCapabilityInline('rcon.execute', req, res);
      if (!allowed) return;
    }

    // Validate cron expression before saving
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)' });
    }

    // The panel does not support seconds-precision (6-field) schedules --
    // see hasUnsupportedCronFieldCount()'s comment for why this must be
    // checked before isCronTooFrequent, not folded into it.
    if (hasUnsupportedCronFieldCount(cronExpression)) {
      return res.status(400).json({ error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday (e.g., "0 */6 * * *").' });
    }

    // Security: Reject tasks that run more frequently than every 5 minutes to prevent DoS
    if (isCronTooFrequent(cronExpression)) {
      return res.status(400).json({ error: 'Tasks cannot run more frequently than every 5 minutes' });
    }

    // Validate the target server exists, if one was explicitly given —
    // createScheduledTask() falls back to the active server when omitted.
    let resolvedServerId = serverId ?? null;
    if (resolvedServerId) {
      const target = await getServer(resolvedServerId);
      if (!target) {
        return res.status(400).json({ error: 'Target server not found' });
      }
    } else {
      const active = await getActiveServer();
      resolvedServerId = active ? active.id : null;
    }

    const result = await createScheduledTask(name, cronExpression, command, resolvedServerId);
    const task = {
      id: result.id,
      name,
      cron_expression: cronExpression,
      command,
      server_id: resolvedServerId,
      enabled: 1
    };

    // Schedule the task — rollback DB entry if scheduling fails
    try {
      scheduler.scheduleTask(task);
    } catch (schedErr) {
      log.error(`Failed to schedule task, rolling back DB entry: ${schedErr.message}`);
      await deleteScheduledTask(result.id);
      return res.status(500).json({ error: 'Failed to schedule task: ' + sanitizeError(schedErr.message) });
    }

    res.json({ success: true, task });
  } catch (error) {
    log.error(`Failed to create scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update a scheduled task
router.put('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    const { name, cronExpression, command, enabled, serverId } = req.body;
    log.info(`PUT /tasks/${id}: name=${name}, cron=${cronExpression}, enabled=${enabled}, serverId=${serverId}`);

    const taskId = parseInt(id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    // Validate name and command length
    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
      return res.status(400).json({ error: 'Invalid task name (max 100 characters)' });
    }
    if (command !== undefined && (typeof command !== 'string' || command.length > 2000)) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)' });
    }
    // Only gate on rcon.execute when THIS request is actually setting the
    // command to something raw -- a caller who only toggles enabled/name/
    // serverId on a task someone else created shouldn't need rcon.execute
    // just because that task's untouched, pre-existing command happens to
    // be raw.
    if (command !== undefined && classifyScheduledCommand(command) === 'raw') {
      const allowed = await requireCapabilityInline('rcon.execute', req, res);
      if (!allowed) return;
    }
    if (
      enabled !== undefined &&
      ![true, false, 0, 1].includes(enabled)
    ) {
      return res.status(400).json({ error: 'enabled must be a boolean or 0/1' });
    }
    const normalizedEnabled =
      enabled === undefined ? undefined : (enabled === true || enabled === 1 ? 1 : 0);

    // Validate cron expression before saving to prevent DB/scheduler inconsistency
    if (cronExpression && !cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)' });
    }

    // The panel does not support seconds-precision (6-field) schedules --
    // see hasUnsupportedCronFieldCount()'s comment for why this must be
    // checked before isCronTooFrequent, not folded into it.
    if (cronExpression && hasUnsupportedCronFieldCount(cronExpression)) {
      return res.status(400).json({ error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday (e.g., "0 */6 * * *").' });
    }

    // Security: Reject tasks that run more frequently than every 5 minutes to prevent DoS
    if (cronExpression && isCronTooFrequent(cronExpression)) {
      return res.status(400).json({ error: 'Tasks cannot run more frequently than every 5 minutes' });
    }

    // Validate the target server, if reassignment was requested
    if (serverId !== undefined && serverId !== null) {
      const target = await getServer(serverId);
      if (!target) {
        return res.status(400).json({ error: 'Target server not found' });
      }
    }

    const updated = await updateScheduledTask(taskId, name, cronExpression, command, normalizedEnabled, serverId);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Reschedule from the merged record, not the request body: a partial update
    // (e.g. the enable/disable toggle) would otherwise re-arm the job without
    // its pinned server and run it against whichever server is active.
    if (updated.enabled) {
      try {
        scheduler.scheduleTask({
          id: taskId,
          name: updated.name,
          cron_expression: updated.cron_expression,
          command: updated.command,
          server_id: updated.server_id,
          enabled: 1
        });
      } catch (schedErr) {
        log.error(`Failed to reschedule task ${taskId}, reverting DB: ${schedErr.message}`);
        // Revert: re-save the old enabled state to avoid phantom active task in DB
        await updateScheduledTask(taskId, undefined, undefined, undefined, 0).catch(err => log.debug(`Failed to revert task ${taskId}: ${err.message}`));
        return res.status(500).json({ error: 'Failed to reschedule task: ' + sanitizeError(schedErr.message) });
      }
    } else {
      scheduler.cancelTask(taskId);
    }

    res.json({ success: true, message: 'Task updated' });
  } catch (error) {
    log.error(`Failed to update scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a scheduled task
router.delete('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    log.info(`DELETE /tasks/${id}`);

    const taskId = parseInt(id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    scheduler.cancelTask(taskId);
    await deleteScheduledTask(taskId);

    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    log.error(`Failed to delete scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Run a scheduled task on demand. Goes through Scheduler.runTaskNow() — the
// same dispatch a cron fire uses — so special commands (restart/save/
// servermsg/bridge:) are handled correctly instead of being sent to RCON as
// a literal string. A restart can run for several minutes (warning
// countdown), so this fires in the background and returns immediately;
// completion shows up in the schedule history.
router.post('/tasks/:id/run', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    const taskId = parseInt(id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    const tasks = await getScheduledTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Unlike a cron fire, "Run now" IS a live request with a real req.user
    // -- check the STORED command (not request body; there isn't one here)
    // against the caller's CURRENT capabilities, not whoever created the
    // task. A task saved as raw by someone who legitimately held
    // rcon.execute at the time still needs it to be manually triggered by
    // someone who doesn't hold it now.
    if (classifyScheduledCommand(task.command) === 'raw') {
      const allowed = await requireCapabilityInline('rcon.execute', req, res);
      if (!allowed) return;
    }

    log.info(`POST /tasks/${taskId}/run: ${task.name}`);
    scheduler.runTaskNow(task).catch(err => {
      log.error(`Manual run of task ${taskId} failed: ${err.message}`);
    });

    res.json({ success: true, message: 'Task triggered' });
  } catch (error) {
    log.error(`Failed to run scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Trigger immediate restart
router.post('/restart-now', async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res.status(400).json({ error: 'Cannot restart a remote server. The process is not managed by this panel.' });
    }

    const scheduler = req.app.get('scheduler');
    const { warningMinutes } = req.body;

    // Parse and validate warningMinutes (0-60 range)
    let parsedWarningMinutes = parseInt(warningMinutes, 10);
    log.info(`POST /restart-now: warningMinutes=${warningMinutes}`);
    if (isNaN(parsedWarningMinutes) || parsedWarningMinutes < 0) {
      parsedWarningMinutes = 5; // Default
    } else if (parsedWarningMinutes > 60) {
      parsedWarningMinutes = 60; // Cap at 60 minutes
    }

    // Run restart in background, passing warningMinutes directly. Labeled
    // "Manual restart" in Schedule History rather than performRestart()'s
    // "Auto Restart" default -- this IS a human clicking Restart Now, and
    // the history record should say so if it later fails. See
    // docs/qa/kevin-adversarial-findings.md Finding 3.
    scheduler.performRestart(parsedWarningMinutes, { label: 'Manual restart' }).catch(err => {
      log.error(`Restart failed: ${err.message}`);
    });

    res.json({ success: true, message: 'Restart initiated' });
  } catch (error) {
    log.error(`Failed to trigger restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Common cron presets for convenience
router.get('/cron-presets', (req, res) => {
  res.json({
    presets: [
      { name: 'Every hour', cron: '0 * * * *' },
      { name: 'Every 2 hours', cron: '0 */2 * * *' },
      { name: 'Every 4 hours', cron: '0 */4 * * *' },
      { name: 'Every 6 hours', cron: '0 */6 * * *' },
      { name: 'Every 12 hours', cron: '0 */12 * * *' },
      { name: 'Daily at midnight', cron: '0 0 * * *' },
      { name: 'Daily at 6 AM', cron: '0 6 * * *' },
      { name: 'Daily at noon', cron: '0 12 * * *' },
      { name: 'Daily at 6 PM', cron: '0 18 * * *' },
      { name: 'Every 30 minutes', cron: '*/30 * * * *' },
      { name: 'Every 15 minutes', cron: '*/15 * * * *' }
    ]
  });
});

// Get schedule execution history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const taskId = req.query.taskId ? parseInt(req.query.taskId, 10) : null;
    const history = await getScheduleHistory(limit, taskId);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get schedule history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear schedule execution history
router.delete('/history', async (req, res) => {
  try {
    await clearScheduleHistory();
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    log.error(`Failed to clear schedule history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
