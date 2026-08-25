/**
 * Storage for operator-ENTERED credentials that must stay editable through
 * the settings UI (Discord bot token, Steam session cookies) — as opposed
 * to utils/jwtSecret.js, which is panel-generated and invisible to the
 * operator.
 *
 * Same reason to move out of db.json as the JWT key: both backup paths
 * (database/init.js's rotation ring, backupService.js's opt-in zip) copy
 * db.json by literal filename, not a directory sweep, so a sibling file
 * here is excluded from both.
 *
 * Deliberately NOT the same failure posture as jwt.secret. Losing the JWT
 * key means every session is invalid and the panel refuses to start — that
 * is proportionate because there is no other way back in. Losing one of
 * these means the Discord bot stops responding or a Workshop download
 * needs a fresh cookie pasted in from Settings — recoverable through the
 * UI these secrets already live in, with everything else (RCON, the
 * panel's own auth) unaffected. So an unreadable file here logs a warning
 * and is treated as "not configured," it never refuses to start.
 */

import fs from "fs";
import path from "path";
import { getDataPaths } from "./paths.js";

function secretFilePath(name) {
  return path.join(getDataPaths().dataDir, `${name}.secret`);
}

export function readUiSecretFile(name, log) {
  const filePath = secretFilePath(name);
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch (err) {
    log?.warn?.(
      `Could not read ${filePath}: ${err.message}. Treating "${name}" as ` +
        "not configured until it is re-entered in Settings.",
    );
    return null;
  }
}

// mode is best-effort: on Windows, fs chmod/mode only toggles the
// read-only attribute, not a real ACL restriction — same documented
// limitation as dataDir/backupDir in database/init.js and jwt.secret,
// not a new gap introduced here.
export function writeUiSecretFile(name, value) {
  const filePath = secretFilePath(name);
  if (value == null || value === "") {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already absent */
    }
    return;
  }
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

/**
 * Read a UI-entered secret, migrating a legacy db.json value the first
 * time this runs on an upgraded install. `legacyValue` is whatever the
 * caller's own getSetting(name) already returned — passed in rather than
 * looked up here so this module has no dependency on database/init.js.
 * `clearLegacy` is only called (and awaited) when a migration actually
 * happens, and a failed migration write falls back to using the legacy
 * value for this run rather than losing it or crashing — same
 * non-critical posture as the rest of this file.
 */
export async function loadUiSecret(name, { legacyValue, clearLegacy, log } = {}) {
  const fromFile = readUiSecretFile(name, log);
  if (fromFile) return fromFile;

  if (legacyValue) {
    try {
      writeUiSecretFile(name, legacyValue);
      if (clearLegacy) await clearLegacy();
      log?.warn?.(
        `Moved "${name}" out of db.json into its own file. Same value, safer location.`,
      );
    } catch (err) {
      log?.warn?.(
        `Could not move "${name}" out of db.json (${err.message}); using ` +
          "it from db.json for now, will retry moving it on the next restart.",
      );
    }
    return legacyValue;
  }

  return null;
}
