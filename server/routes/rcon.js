import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:RCON');
import { getCommandHistory } from '../database/init.js';
import { PZ_COMMANDS } from '../utils/commands.js';
import { sanitizeError } from '../utils/sanitize.js';
import { testRconConnection } from '../services/rcon.js';
import { requirePermission } from '../services/permissions.js';
import { ErrorCode } from '../utils/errorCodes.js';

const router = express.Router();

// Mixed, not file-wide: /execute runs an ARBITRARY raw RCON command with no
// structural validation beyond a length cap — meaningfully more powerful
// than the specific, validated actions in players.js (kick/ban/etc.), and
// includes things like `quit` that can shut the server down. That, plus
// connection lifecycle (/connect, /disconnect, /test — reconfigures which
// RCON endpoint the panel talks to), are admin+technician only, NOT
// moderator: a moderator doing player moderation should use players.js's
// structured endpoints, not an open console. Read-only status/reference
// routes below (/status, /health, /commands, /commands/:category) stay open
// to every logged-in role deliberately — nothing sensitive is returned and
// a moderator plausibly wants to see RCON status or the command reference.
//
// /history is NOT in that group, despite looking like one more read-only
// reference route: it returns the verbatim command_history log, and
// logCommand() (database/init.js) stores the exact command STRING that was
// sent, unredacted -- including, e.g., `adduser "player" "password"` from
// the whitelist-add flow (a real PZ join password) or anything typed into
// this file's own /execute console. Leaving it ungated meant any logged-in
// role -- a moderator included, who never holds rcon.execute -- could read
// every admin/technician's past RCON console session and every whitelist
// password ever set, through an endpoint whose neighbors really are
// harmless. Gated the same as /execute/connect/disconnect/test.

function validateTestInput(host, port, password) {
  if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return 'Invalid host format';
  }
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return 'Invalid port (1-65535)';
  }
  if (password !== undefined && (typeof password !== 'string' || password.length > 256)) {
    return 'Invalid password format';
  }
  return null;
}

// Execute raw RCON command
router.post('/execute', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { command } = req.body;
    log.info(`POST /execute: ${(command || '').substring(0, 100)}`);
    
    if (!command) {
      return res.status(400).json({ error: 'Command is required', code: ErrorCode.RCON_COMMAND_REQUIRED });
    }

    // Validate command type and length
    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)', code: ErrorCode.RCON_COMMAND_INVALID });
    }
    
    const result = await rconService.execute(command);
    
    // Emit to connected clients
    const io = req.app.get('io');
    if (io) io.to('logs').emit('rcon:response', {
      command,
      response: result.response || result.error,
      success: result.success,
      timestamp: new Date().toISOString()
    });
    
    res.json(result);
  } catch (error) {
    log.error(`RCON execute failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get RCON connection status
router.get('/status', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Connect to RCON
router.post('/connect', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { host, port, password } = req.body;
    log.info(`POST /connect (host=${host || 'default'}, port=${port || 'default'}, password=${password ? '***' : 'none'})`);
    
    // Validate host format if provided (only alphanumeric, dots, hyphens)
    if (host !== undefined) {
      if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
        return res.status(400).json({ success: false, error: 'Invalid host format', code: ErrorCode.RCON_INVALID_HOST });
      }
    }

    // Validate port if provided
    if (port !== undefined) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ success: false, error: 'Invalid port (1-65535)', code: ErrorCode.RCON_INVALID_PORT });
      }
    }

    // Validate password if provided
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length > 256) {
        return res.status(400).json({ success: false, error: 'Invalid password format', code: ErrorCode.RCON_INVALID_PASSWORD });
      }
    }
    
    if (host || port || password) {
      rconService.updateConfig(host, port, password);
    }
    
    const connected = await rconService.connect();
    if (connected) {
      res.json({ success: true, message: 'Connected to RCON' });
    } else {
      res.status(503).json({ success: false, error: 'Could not connect to RCON. Is the server running and RCON enabled?', code: ErrorCode.RCON_CONNECT_FAILED });
    }
  } catch (error) {
    log.error(`RCON connect failed: ${error.message}`);
    const rconService = req.app.get('rconService');
    const friendlyError = rconService.getUserFriendlyError(error.message);
    res.status(500).json({ success: false, error: friendlyError });
  }
});

// Test arbitrary RCON credentials without applying them — lets the UI
// validate host/port/password before the user saves a server's settings.
router.post('/test', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const { host, port, password } = req.body;
    log.info(`POST /test (host=${host || 'none'}, port=${port || 'none'})`);

    const validationError = validateTestInput(host, port, password);
    if (validationError) {
      return res.status(400).json({ success: false, error: 'invalid_input', detail: validationError });
    }

    const result = await testRconConnection({ host, port: parseInt(port, 10), password });
    res.json(result);
  } catch (error) {
    log.error(`RCON test failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'internal_error', detail: sanitizeError(error.message) });
  }
});

// Health check - test if connection is actually alive
router.get('/health', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const health = await rconService.healthCheck();
    if (health.healthy) {
      res.json({ success: true, ...health });
    } else {
      res.status(503).json({ success: false, ...health });
    }
  } catch (error) {
    res.status(500).json({ success: false, reason: sanitizeError(error.message) });
  }
});

// Disconnect from RCON
router.post('/disconnect', requirePermission('rcon.execute'), async (req, res) => {
  try {
    log.info('POST /disconnect');
    const rconService = req.app.get('rconService');
    await rconService.disconnect();
    res.json({ success: true, message: 'Disconnected from RCON' });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get command history
router.get('/history', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const history = await getCommandHistory(limit);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get command history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available commands
router.get('/commands', (req, res) => {
  res.json({ commands: PZ_COMMANDS });
});

// Get commands by category
router.get('/commands/:category', (req, res) => {
  const { category } = req.params;
  const filtered = Object.entries(PZ_COMMANDS)
    .filter(([_, cmd]) => cmd.category === category)
    .reduce((acc, [key, cmd]) => {
      acc[key] = cmd;
      return acc;
    }, {});
  
  res.json({ commands: filtered });
});

export default router;
