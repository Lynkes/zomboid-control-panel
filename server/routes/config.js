import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Config");
import { getAllSettings, getSetting, setSetting } from "../database/init.js";
import {
  sanitizeError,
  SENSITIVE_FIELD_RE,
  isMaskedSecret,
  maskSensitiveObject,
} from "../utils/sanitize.js";
import net from "net";
import { requirePermission } from "../services/permissions.js";
import {
  MOD_CHECK_INTERVAL_MINUTES_MAX,
  MOD_CHECK_INTERVAL_MINUTES_MIN,
  minutesToCheckIntervalMs,
} from "../services/modChecker.js";
import { requireStoppedForLocalConfigMutation } from "../services/configMutationGuard.js";
import {
  requireIntInRange,
  PORT_MIN,
  PORT_MAX,
  MEMORY_GB_MIN,
  MIN_MEMORY_GB_MAX,
  MAX_MEMORY_GB_MAX,
} from "./server.js";

// Local to this route: autoExportMaxPerPlayer has no counterpart check in
// server.js (or anywhere else), so unlike the port/memory constants above
// there's no cross-file drift risk to guard against -- a plain local
// constant is enough to remove the hand-typed literal. Range matches
// Settings.tsx's own input (min=1 max=50).
const AUTO_EXPORT_MAX_PER_PLAYER_MIN = 1;
const AUTO_EXPORT_MAX_PER_PLAYER_MAX = 50;

// Also local: neither of these has a server.js counterpart. Ranges chased
// from their consuming services rather than guessed -- see the comments at
// each call site below for the source. modRestartDelay's floor is 0, not
// Settings.tsx's min=1: the service (modChecker.js's setRestartOptions) is
// the authority on what the system can actually do, and it demonstrably
// accepts 0. Refusing a value here that the consumer handles fine would be
// a NEW disagreement between two layers -- the exact bug class this whole
// thread closed, just pointing the other way (a save that rejects what the
// consumer accepts, instead of a wizard that refuses what /app-settings
// accepts). Settings.tsx keeping min=1 is fine and unrelated: that's a UI
// recommendation, not a claim about server capability, and the two are
// allowed to differ. See 2026-08-23 config.js numeric-field audit part 5.
const MOD_RESTART_DELAY_MIN = 0;
const MOD_RESTART_DELAY_MAX = 30;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN = 0;
const SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX = 60;

const router = express.Router();

// Validation helpers
const VALID_SETTINGS_KEYS = [
  "rconHost",
  "rconPort",
  "rconPassword",
  "serverPath",
  "serverConfigPath",
  "zomboidDataPath",
  "steamcmdPath",
  "steamUpdateAccount",
  "steamApiKey",
  "serverName",
  "minMemory",
  "maxMemory",
  "serverPort",
  "modCheckInterval",
  "modAutoRestart",
  "modRestartDelay",
  "serverAutoUpdate",
  "serverAutoUpdateWarningMinutes",
  "darkMode",
  "autoReconnect",
  "reconnectInterval",
  // Discord config is owned by /api/discord (discordBotToken,
  // discordAdminRoleId, ...). The old discordEnabled/discordToken/
  // discordAdminRole keys are deliberately NOT listed: nothing reads them, so
  // allowing them here would accept a write that silently never takes effect.
  "discordGuildId",
  "autoStartServer",
  "panelPort",
  "httpsEnabled",
  "httpsPort",
  "httpsKeyPath",
  "httpsCertPath",
  "corsAllowedOrigins",
  "corsAllowAll",
  "corsAllowPrivateNetworks",
  "corsDebug",
  "panelBridgeAutoUpdate",
  "autoExportOnLogin",
  "autoExportMaxPerPlayer",
  // Opt-in external public-IP lookup (api.ipify.org) shown on the dashboard/
  // panel-info — off by default (see serverManager.fetchPublicIp).
  "enablePublicIpLookup",
  // Workshop collection sync — mirrors tracked mods into a Steam collection.
  // steamSessionId / steamLoginSecure are cookie pairs; treated as secrets.
  "workshopCollectionId",
  "workshopCollectionAutoSync",
  "steamSessionId",
  "steamLoginSecure",
  // Chat page Quick Messages presets — array of strings.
  "chatPresets",
  // Dashboard LAN IP override — pick which detected interface to display
  // when the host has more than one (multiple VPN meshes, etc). Empty
  // string clears it back to auto-detect.
  "lanIpAddress",
  "panelBridgeSftpEnabled",
  "panelBridgeSftpHost",
  "panelBridgeSftpPort",
  "panelBridgeSftpUsername",
  "panelBridgeSftpPassword",
  "panelBridgeSftpBridgePath",
  "panelBridgeSftpPollIntervalSeconds",
  "panelBridgeSftpLogPath",
  "panelBridgeSftpConfigPath",
];

const OPTION_NAME_REGEX = /^[a-zA-Z0-9_]{1,64}$/;
const OPTION_VALUE_REGEX = /^[a-zA-Z0-9_.,:;\/ -]{0,256}$/;
const ORIGIN_DELIMITER_REGEX = /[\n,;]+/;
const MAX_CORS_ALLOWED_ORIGINS_LENGTH = 5000;
const MAX_CORS_ALLOWED_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

function isValidOptionName(name) {
  return typeof name === "string" && OPTION_NAME_REGEX.test(name);
}

function isValidOptionValue(value) {
  const strVal = String(value);
  return OPTION_VALUE_REGEX.test(strVal);
}

function validateCorsAllowedOrigins(value) {
  if (typeof value !== "string") {
    return "CORS allowed origins must be a string list";
  }

  if (value.length > MAX_CORS_ALLOWED_ORIGINS_LENGTH) {
    return `CORS allowed origins list is too long (max ${MAX_CORS_ALLOWED_ORIGINS_LENGTH} characters)`;
  }

  const rawOrigins = value
    .split(ORIGIN_DELIMITER_REGEX)
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (rawOrigins.length > MAX_CORS_ALLOWED_ORIGINS) {
    return `Too many CORS origins (max ${MAX_CORS_ALLOWED_ORIGINS})`;
  }

  for (const origin of rawOrigins) {
    if (origin.length > MAX_CORS_ORIGIN_LENGTH) {
      return `Origin is too long (max ${MAX_CORS_ORIGIN_LENGTH} chars): ${origin.slice(0, 40)}...`;
    }
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol)) {
        return `Only http/https origins are allowed: ${origin}`;
      }
    } catch {
      return `Invalid origin format: ${origin}`;
    }
  }

  return null;
}

// Get server configuration
router.get("/", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const config = await serverManager.getServerConfig();
    res.json({ config });
  } catch (error) {
    log.error(`Failed to get config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update server configuration
router.put("/", requirePermission("server.configure"), requireStoppedForLocalConfigMutation, async (req, res) => {
  try {
    log.info("PUT /config — saving server config");
    const serverManager = req.app.get("serverManager");
    const { config } = req.body;

    if (!config) {
      return res.status(400).json({ error: "Config is required" });
    }

    const saved = await serverManager.saveServerConfig(config);
    if (!saved?.success) {
      return res.status(500).json({
        error: sanitizeError(saved?.error || "Configuration could not be written"),
      });
    }
    res.json({ success: true, message: "Configuration saved" });
  } catch (error) {
    log.error(`Failed to save config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reload server options via RCON
router.post("/reload", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.reloadOptions();
    res.json(result);
  } catch (error) {
    log.error(`Failed to reload options: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get server options via RCON
router.get("/options", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.showOptions();
    res.json(result);
  } catch (error) {
    log.error(`Failed to get options: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Change a specific option via RCON
router.post("/option", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { name, value } = req.body;
    log.info(`POST /option: ${name}=${value}`);

    if (!name || value === undefined) {
      return res
        .status(400)
        .json({ error: "Option name and value are required" });
    }

    // Validate option name and value to prevent command injection
    if (!isValidOptionName(name)) {
      return res.status(400).json({ error: "Invalid option name format" });
    }

    if (!isValidOptionValue(value)) {
      return res.status(400).json({ error: "Invalid option value format" });
    }

    const result = await rconService.changeOption(name, value);
    res.json(result);
  } catch (error) {
    log.error(`Failed to change option: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Sensitive settings are masked in API responses by pattern (see
// SENSITIVE_FIELD_RE / maskSensitiveObject in utils/sanitize.js) rather than
// an explicit key list, so a newly added secret-shaped setting (jwtSecret,
// discordBotToken, ...) is masked automatically instead of leaking in
// plaintext until someone remembers to list it here.
const maskSensitiveSettings = maskSensitiveObject;

// Get application settings
router.get("/app-settings", async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ settings: maskSensitiveSettings(settings) });
  } catch (error) {
    log.error(`Failed to get app settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update application settings. Admin-gated: this endpoint can flip
// corsAllowAll (disables CORS origin checking panel-wide) and other
// security-relevant settings, so any authenticated-but-unprivileged
// account must not be able to write it.
router.put("/app-settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const { settings } = req.body;
    log.info(
      `PUT /app-settings — updating ${settings ? Object.keys(settings).length : 0} keys: [${settings ? Object.keys(settings).join(", ") : ""}]`,
    );

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "Settings are required" });
    }

    // Only allow valid setting keys to prevent prototype pollution
    const validEntries = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTINGS_KEYS.includes(key)) {
        log.warn(`Invalid setting key rejected: ${key}`);
        continue;
      }

      if (key === "corsAllowedOrigins") {
        const corsValidationError = validateCorsAllowedOrigins(value);
        if (corsValidationError) {
          return res.status(400).json({ error: corsValidationError });
        }
      }

      if (
        key === "modCheckInterval" &&
        minutesToCheckIntervalMs(value) === null
      ) {
        return res.status(400).json({
          error: `modCheckInterval must be a whole number of minutes from ${MOD_CHECK_INTERVAL_MINUTES_MIN} to ${MOD_CHECK_INTERVAL_MINUTES_MAX}`,
        });
      }

      // Bound chased from the consuming service (modChecker.js's
      // setRestartOptions: `Math.max(0, Math.min(30, val))`): [0, 30].
      // Settings.tsx's own input says min=1, a real discrepancy -- flagged
      // rather than resolved silently, and the ruling went with the
      // service's floor, not the client's: the service is the authority on
      // what the system can do, and refusing 0 here while the consumer
      // accepts it fine would be a NEW save-vs-consumer disagreement, the
      // same bug class this whole thread closed. Settings.tsx keeping min=1
      // is fine and unrelated -- a UI recommendation, not a capability
      // claim. See 2026-08-23 config.js numeric-field audit part 5.
      if (key === "modRestartDelay") {
        const modRestartDelayCheck = requireIntInRange(
          value,
          MOD_RESTART_DELAY_MIN,
          MOD_RESTART_DELAY_MAX,
          "Mod restart delay (minutes)",
        );
        if (!modRestartDelayCheck.ok) {
          return res.status(400).json({ error: modRestartDelayCheck.message });
        }
      }

      // Bound chased from the consuming service (updateChecker.js's
      // parseAutoUpdateWarningMinutes: `Math.min(60, Math.max(0, ...))`,
      // default 15) -- matches Settings.tsx's own input (min=0 max=60)
      // exactly, no discrepancy to report for this one.
      if (key === "serverAutoUpdateWarningMinutes") {
        const warningMinutesCheck = requireIntInRange(
          value,
          SERVER_AUTO_UPDATE_WARNING_MINUTES_MIN,
          SERVER_AUTO_UPDATE_WARNING_MINUTES_MAX,
          "Server auto-update warning (minutes)",
        );
        if (!warningMinutesCheck.ok) {
          return res.status(400).json({ error: warningMinutesCheck.message });
        }
      }

      if (key === "lanIpAddress" && value !== "" && net.isIP(value) !== 4) {
        return res
          .status(400)
          .json({ error: "lanIpAddress must be an IPv4 address or empty" });
      }

      if (
        [
          "corsAllowAll",
          "corsAllowPrivateNetworks",
          "corsDebug",
          "panelBridgeAutoUpdate",
          "autoExportOnLogin",
          "enablePublicIpLookup",
          // The other 8 boolean-shaped keys in VALID_SETTINGS_KEYS, added in
          // the same pass as rconPort/serverPort/min+maxMemory/panelPort
          // below -- accepted any truthy/falsy JS value with no gate at all
          // until now. See 2026-08-23 config.js numeric-field audit.
          "modAutoRestart",
          "serverAutoUpdate",
          "darkMode",
          "autoReconnect",
          "httpsEnabled",
          "autoStartServer",
          "workshopCollectionAutoSync",
          "panelBridgeSftpEnabled",
        ].includes(key) &&
        typeof value !== "boolean"
      ) {
        return res.status(400).json({ error: `${key} must be true or false` });
      }

      // httpsCertPath/httpsKeyPath used to be accepted as any string and
      // only ever checked at panel BOOT (utils/certs.js), where a bad value
      // (directory instead of file, unreadable) crashed the whole process
      // via an unguarded fs.readFileSync -- see that file's own fix for the
      // other half of this. Rejecting a bad value here, immediately, is
      // what actually prevents an operator from saving one in the first
      // place; the boot-time fix alone only stops the crash for a value
      // that goes bad AFTER being saved (moved/deleted/permissions changed
      // later), which is a real but separate case this can't catch.
      if (
        (key === "httpsCertPath" || key === "httpsKeyPath") &&
        value !== ""
      ) {
        if (typeof value !== "string") {
          return res.status(400).json({ error: `${key} must be a string` });
        }
        let stat;
        try {
          stat = fs.statSync(value);
        } catch {
          return res.status(400).json({
            error: `${key} does not point to a file that exists: ${value}`,
          });
        }
        if (!stat.isFile()) {
          return res.status(400).json({
            error: `${key} must be a file, not a directory: ${value}`,
          });
        }
        try {
          fs.accessSync(value, fs.constants.R_OK);
        } catch {
          return res.status(400).json({
            error: `${key} exists but is not readable by the panel: ${value}`,
          });
        }
      }

      if (key === "httpsPort") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return res.status(400).json({
            error: "httpsPort must be a whole number from 1 to 65535",
          });
        }
        const panelPort = await getSetting("panelPort");
        if (panelPort && port === Number(panelPort)) {
          return res.status(400).json({
            error: `httpsPort cannot be the same as the panel's HTTP port (${panelPort})`,
          });
        }
      }

      // Same missing-range-check shape httpsPort/reconnectInterval closed
      // above, but this one IS the lockout case, not the mild one: panelPort
      // sat in this same allowed-keys list, two lines from httpsPort, with
      // no case at all here. An out-of-range value saved silently (200,
      // no error), index.js only discovers it can't bind at the NEXT
      // restart and falls back to 3001 -- but the Restart Panel button has
      // already sent the browser to the port the operator typed, which
      // nothing is listening on. Range matches auth.js's /setup check for
      // the same field (ErrorCode.SETUP_PANEL_PORT_INVALID) -- reusing
      // server.js's requireIntInRange rather than a third hand-rolled
      // range check. See 2026-08-23 validateInt-coerces / config.js
      // numeric-field audit.
      //
      // The collision check below is bidirectional on purpose: httpsPort's
      // check above only compared a new httpsPort against the STORED
      // panelPort. Left one-directional, the exact collision that guard
      // exists to prevent was still reachable by approaching from the other
      // side -- setting panelPort to whatever httpsPort already is. A guard
      // reachable by walking around it from the other direction isn't a
      // guard, it's a speed bump on one approach.
      if (key === "panelPort") {
        const panelPortCheck = requireIntInRange(value, PORT_MIN, PORT_MAX, "Panel port");
        if (!panelPortCheck.ok) {
          return res.status(400).json({ error: panelPortCheck.message });
        }
        const httpsPort = await getSetting("httpsPort");
        if (httpsPort && panelPortCheck.value === Number(httpsPort)) {
          return res.status(400).json({
            error: `panelPort cannot be the same as the panel's HTTPS port (${httpsPort})`,
          });
        }
      }

      // The exact four fields server.js's /install, /quick-setup,
      // /configure-rcon and /configure-network now refuse out-of-range on
      // (2026-08-23 validateInt-coerces audit, commit 39f836f) were also
      // reachable through THIS route with zero validation -- a second door
      // onto the same four values, invisible from inside server.js since it
      // lives in a completely different file. Same ranges as server.js's
      // checks so the two doors can't disagree with each other.
      if (key === "rconPort") {
        const rconPortCheck = requireIntInRange(value, PORT_MIN, PORT_MAX, "RCON port");
        if (!rconPortCheck.ok) {
          return res.status(400).json({ error: rconPortCheck.message });
        }
      }

      if (key === "serverPort") {
        const serverPortCheck = requireIntInRange(value, PORT_MIN, PORT_MAX, "Game port");
        if (!serverPortCheck.ok) {
          return res.status(400).json({ error: serverPortCheck.message });
        }
      }

      if (key === "minMemory") {
        const minMemoryCheck = requireIntInRange(value, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
        if (!minMemoryCheck.ok) {
          return res.status(400).json({ error: minMemoryCheck.message });
        }
      }

      if (key === "maxMemory") {
        const maxMemoryCheck = requireIntInRange(value, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
        if (!maxMemoryCheck.ok) {
          return res.status(400).json({ error: maxMemoryCheck.message });
        }
      }

      // Lower priority than the fields above -- a garbage value here
      // doesn't misdirect anything, it self-heals to 3 via `Number(...) ||
      // 3` the next time it's read (see index.js's export-rotation code).
      // But an unvalidated garbage value would still sit in the database
      // forever, unreadable by that fallback's intent, as a trap for
      // whoever next reads that column expecting a real number. Range
      // matches Settings.tsx's own input (min=1 max=50).
      if (key === "autoExportMaxPerPlayer") {
        const autoExportMaxCheck = requireIntInRange(value, AUTO_EXPORT_MAX_PER_PLAYER_MIN, AUTO_EXPORT_MAX_PER_PLAYER_MAX, "Auto-export copies kept");
        if (!autoExportMaxCheck.ok) {
          return res.status(400).json({ error: autoExportMaxCheck.message });
        }
      }

      // Same missing-range-check shape as httpsPort above, but the worst
      // case if it slips through is a too-fast/too-slow reconnect timer,
      // not a lockout -- worth closing anyway since it's one check in the
      // same loop, not worth its own investigation.
      if (key === "reconnectInterval") {
        const interval = Number(value);
        if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
          return res.status(400).json({
            error: "reconnectInterval must be a whole number from 1 to 60",
          });
        }
      }

      if (key === "chatPresets") {
        // Array of short strings, max 50 entries, each <=500 chars.
        if (!Array.isArray(value)) {
          return res
            .status(400)
            .json({ error: "chatPresets must be an array" });
        }
        if (value.length > 50) {
          return res
            .status(400)
            .json({ error: "chatPresets supports up to 50 entries" });
        }
        if (!value.every((v) => typeof v === "string" && v.length <= 500)) {
          return res.status(400).json({
            error: "chatPresets entries must be strings up to 500 characters",
          });
        }
      }

      validEntries.push([key, value]);
    }

    // Never overwrite a stored secret with the masked sentinel we send to
    // the client. Without this guard, clicking Save after a page reload
    // (where the input pre-fills with •••...) would silently corrupt
    // RCON passwords, Discord tokens, and Steam cookies. See workshop
    // collection "cookies not configured" bug for the symptom.
    const filtered = validEntries.filter(([key, value]) => {
      if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(value)) {
        log.info(
          `Preserving stored value for sensitive key "${key}" (masked input ignored)`,
        );
        return false;
      }
      return true;
    });

    for (const [key, value] of filtered) {
      if (key === "modCheckInterval") continue;
      await setSetting(key, value);
    }

    const modCheckIntervalEntry = filtered.find(
      ([key]) => key === "modCheckInterval",
    );
    if (modCheckIntervalEntry) {
      const [, minutes] = modCheckIntervalEntry;
      const modChecker = req.app.get("modChecker");
      if (modChecker?.setCheckIntervalMinutes) {
        await modChecker.setCheckIntervalMinutes(minutes);
      } else {
        await setSetting("modCheckInterval", Number(minutes));
      }
    }

    const modChecker = req.app.get("modChecker");
    const autoRestartEntry = filtered.find(
      ([key]) => key === "modAutoRestart",
    );
    if (autoRestartEntry && modChecker?.setUpdateCallback) {
      const [, enabled] = autoRestartEntry;
      await modChecker.setUpdateCallback(
        enabled
          ? async (updatedMods) => modChecker.handleModUpdate(updatedMods)
          : null,
      );
    }

    const restartDelayEntry = filtered.find(
      ([key]) => key === "modRestartDelay",
    );
    if (restartDelayEntry && modChecker?.setRestartOptions) {
      const [, warningMinutes] = restartDelayEntry;
      await modChecker.setRestartOptions({ warningMinutes });
    }

    // Reload serverManager and rconService configs after settings change
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const reloadWarnings = [];
    if (serverManager?.reloadConfig) {
      try {
        await serverManager.reloadConfig();
      } catch (reloadErr) {
        log.warn(
          `serverManager reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "Server manager failed to reload — restart may be required",
        );
      }
    }
    if (rconService?.loadConfig) {
      try {
        rconService.configLoaded = false;
        await rconService.loadConfig();
      } catch (reloadErr) {
        log.warn(
          `rconService reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "RCON service failed to reload — reconnect may be required",
        );
      }
    }
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig === "function") {
      try {
        await refreshCorsConfig();
      } catch (reloadErr) {
        log.warn(
          `CORS config reload failed after settings save: ${reloadErr.message}`,
        );
        reloadWarnings.push(
          "CORS settings could not be reloaded — panel restart may be required",
        );
      }
    }

    const response = { success: true, message: "Settings saved" };
    if (reloadWarnings.length) response.warnings = reloadWarnings;
    res.json(response);
  } catch (error) {
    log.error(`Failed to save app settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// CORS diagnostics for remote access troubleshooting. Admin-only, same tier
// as debug.js: this is internal panel/network diagnostic surface, not a
// server-operation task, and can mutate CORS state (clearing the blocked
// list, forcing a reload).
router.get("/cors-debug", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (typeof getCorsDebugSnapshot !== "function") {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available" });
    }
    res.json({ diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to get CORS diagnostics: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/cors-debug/reload", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig !== "function") {
      return res
        .status(500)
        .json({ error: "CORS config reload is not available" });
    }
    const diagnostics = await refreshCorsConfig();
    res.json({ success: true, diagnostics });
  } catch (error) {
    log.error(`Failed to reload CORS config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/cors-debug/blocked", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const clearCorsBlockedOrigins = req.app.get("clearCorsBlockedOrigins");
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (
      typeof clearCorsBlockedOrigins !== "function" ||
      typeof getCorsDebugSnapshot !== "function"
    ) {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available" });
    }

    clearCorsBlockedOrigins();
    res.json({ success: true, diagnostics: getCorsDebugSnapshot() });
  } catch (error) {
    log.error(`Failed to clear blocked CORS origins: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get paths configuration
router.get("/paths", async (req, res) => {
  try {
    res.json({
      serverPath: process.env.PZ_SERVER_PATH || "",
      savePath: process.env.PZ_SAVE_PATH || "",
      serverBat:
        process.env.PZ_SERVER_BAT ||
        (process.platform === "win32"
          ? "StartServer64.bat"
          : "start-server.sh"),
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// serverManager.savePath set here is what server.js's /wipe and
// /wipe/preview join with "Saves/Multiplayer/{serverName}" before recursively
// deleting -- the previous check here only rejected a literal ".." and never
// required an absolute path, so a relative value would resolve against
// whatever the panel process's cwd happens to be at wipe time instead of the
// real Zomboid data folder. Matches server.js's own isValidPath: absolute,
// no traversal.
function isValidConfigPath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length > 500) return false;
  const normalized = path.normalize(inputPath);
  if (normalized.includes("..")) return false;
  return path.isAbsolute(normalized);
}

// Update paths (runtime only - doesn't persist to .env)
//
// INVESTIGATED 2026-08-24 (conv-hunt-resume, config-live-pointer-mutations-
// no-running-guard): unlike PUT / above, this has no
// requireStoppedForLocalConfigMutation. Concluded no guard is needed --
// this mutates serverManager's in-memory serverPath/savePath fields only
// (explicitly runtime-only, never touches a file or the database), and
// every consumer that could turn a stale pointer into something worse than
// a confusing display is independently guarded already: server.js's /wipe
// and /wipe/preview require BOTH a real OS-level process scan confirming
// the server is stopped (not derived from this field) AND the specific
// Saves/Multiplayer/{serverName} subpath to exist (404s rather than
// silently acting on an unrelated directory in the overwhelming majority of
// misconfigurations); PUT /config's saveServerConfig() is already gated by
// requireStoppedForLocalConfigMutation; and backupService/chunks.js resolve
// their own paths from the database (getActiveServer()/getSetting()), not
// from this field at all, so this route cannot affect them. The worst
// realistic outcome while the real server keeps running unaffected on its
// old path is the panel's own config/status displays showing stale, missing,
// or (rarely) a different install's data -- confusing, self-correcting once
// noticed, never destructive. A running-state guard would not close the one
// real edge case found (a wrong-but-structurally-matching savePath later
// enabling a misdirected wipe after a legitimate stop) since that risk
// exists independent of the server's state when this route was called.
router.put("/paths", requirePermission("server.configure"), async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const { serverPath, savePath } = req.body;

    // Validate paths
    if (serverPath !== undefined && !isValidConfigPath(serverPath)) {
      return res.status(400).json({ error: "Invalid server path" });
    }
    if (savePath !== undefined && !isValidConfigPath(savePath)) {
      return res.status(400).json({ error: "Invalid save path" });
    }

    serverManager.updatePaths(serverPath, savePath);

    res.json({ success: true, message: "Paths updated" });
  } catch (error) {
    log.error(`Failed to update paths: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get RCON configuration
router.get("/rcon", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Validation for RCON config
const RCON_HOST_REGEX = /^[a-zA-Z0-9.-]{1,255}$/;
const RCON_PASSWORD_MAX_LENGTH = 256;

// Update RCON configuration
//
// INVESTIGATED 2026-08-24 (conv-hunt-resume, config-live-pointer-mutations-
// no-running-guard): also has no requireStoppedForLocalConfigMutation, also
// concluded no guard is needed, for a stronger reason than /paths above:
// rcon.js's updateConfig() disconnects any live connection immediately on a
// config change (see rcon.js), and every RCON action after that reconnects
// against the NEW config -- a wrong host/port simply fails to connect. This
// fails LOUD and immediately: there is no code path where a bad RCON
// pointer produces plausible-but-wrong data, since RCON is a live
// connection, not a file read. The existing /test-rcon route and RCON
// status reporting (`connected: false`) already surface this without any
// guard needed here.
router.put("/rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { host, port, password } = req.body;

    // Validate host (if provided)
    if (host !== undefined) {
      if (typeof host !== "string" || !RCON_HOST_REGEX.test(host)) {
        return res.status(400).json({ error: "Invalid host format" });
      }
    }

    // Validate port (if provided)
    if (port !== undefined) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res
          .status(400)
          .json({ error: "Invalid port number (must be 1-65535)" });
      }
    }

    // Validate password length (if provided)
    if (password !== undefined) {
      if (
        typeof password !== "string" ||
        password.length > RCON_PASSWORD_MAX_LENGTH
      ) {
        return res.status(400).json({ error: "Invalid password format" });
      }
    }

    rconService.updateConfig(host, port, password);

    res.json({ success: true, message: "RCON configuration updated" });
  } catch (error) {
    log.error(`Failed to update RCON config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Test RCON connection
router.post("/test-rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");

    // Try to connect
    const connected = await rconService.connect();

    if (connected) {
      // Try a lightweight command to verify the connection is alive
      // Avoid 'help' — PZ dumps a huge response that can overflow RCON packets and hang
      try {
        // execute() reports a failed command by return value, so the catch
        // below only ever saw transport-level errors.
        const probe = await rconService.execute("players", { skipLog: true });
        if (!probe?.success) {
          res.json({
            success: true,
            message:
              "Connected but command failed: " + sanitizeError(probe?.error),
            connected: true,
            warning: true,
          });
          return;
        }
        res.json({
          success: true,
          message: "RCON connection successful",
          connected: true,
        });
      } catch (cmdError) {
        res.json({
          success: true,
          message:
            "Connected but command failed: " + sanitizeError(cmdError.message),
          connected: true,
          warning: true,
        });
      }
    } else {
      res.json({
        success: false,
        message: "Failed to connect to RCON",
        connected: false,
      });
    }
  } catch (error) {
    log.error(`RCON test failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: sanitizeError(error.message),
      connected: false,
    });
  }
});

export default router;
