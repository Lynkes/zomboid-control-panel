/**
 * The panel's JWT signing key, stored OUTSIDE db.json.
 *
 * db.json is copied wholesale by two backup paths (the automatic rotation
 * ring in database/init.js and the opt-in "include DB" game-backup zip in
 * backupService.js) — both copy it by literal filename, not a directory
 * sweep, so a signing key kept here instead never rides along in either.
 *
 * Precedence, matching the existing RCON_PASSWORD / STEAM_API_KEY pattern:
 *   1. JWT_SECRET / JWT_SECRET_FILE (readSecret) — an operator-pinned value,
 *      e.g. a Docker/K8s secret mount, or to share one key across multiple
 *      panel instances behind a load balancer.
 *   2. <dataDir>/jwt.secret — auto-generated once and persisted.
 *
 * A file that exists but can't be read or is empty is a hard startup
 * failure, not a trigger to mint a fresh key. Silently regenerating would
 * pass every health check while logging out the entire user base with
 * nothing in the log to explain why — see loadOrCreateJwtSecret below.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDataPaths } from "./paths.js";
import { readSecret } from "./secrets.js";

export function getJwtSecretPath() {
  return path.join(getDataPaths().dataDir, "jwt.secret");
}

// mode is best-effort: on Windows, fs chmod/mode only toggles the
// read-only attribute, not a real ACL restriction — same documented
// limitation already called out for dataDir/backupDir in database/init.js,
// not a new gap introduced here.
function writeSecretFile(secretPath, value) {
  fs.writeFileSync(secretPath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    /* best-effort: Windows / network shares */
  }
}

/**
 * Resolve the JWT signing key. `legacyValue` is db.json's old `jwtSecret`
 * setting, if the caller still has one (pre-migration installs) — pass
 * null/undefined once nothing needs migrating.
 *
 * Returns { secret, source } where source is one of:
 *   "env"       — JWT_SECRET / JWT_SECRET_FILE override, file untouched.
 *   "file"      — loaded the existing <dataDir>/jwt.secret unchanged.
 *   "migrated"  — no file yet, but a legacy value existed: written to the
 *                 file VERBATIM (same bytes), not regenerated. Every
 *                 already-issued token still verifies against it.
 *   "generated" — no env, no file, no legacy value: a genuinely fresh
 *                 install. Only this branch mints a new key.
 */
export async function loadOrCreateJwtSecret({ legacyValue } = {}) {
  const envSecret = readSecret("JWT_SECRET");
  if (envSecret) {
    return { secret: envSecret, source: "env" };
  }

  const secretPath = getJwtSecretPath();

  if (fs.existsSync(secretPath)) {
    let raw;
    try {
      raw = fs.readFileSync(secretPath, "utf8");
    } catch (err) {
      throw new Error(
        `JWT secret file exists but could not be read (${secretPath}): ${err.message}. ` +
          "Refusing to start rather than silently issuing a new signing key, which " +
          "would log out every user with nothing in the log to explain why. Fix the " +
          "file's permissions, or delete it to force a fresh key (this signs everyone " +
          "out), then restart.",
      );
    }
    const secret = raw.trim();
    if (!secret) {
      throw new Error(
        `JWT secret file exists but is empty (${secretPath}). Refusing to start rather ` +
          "than silently issuing a new signing key, which would log out every user with " +
          "nothing in the log to explain why. Delete the file to force a fresh key (this " +
          "signs everyone out), then restart.",
      );
    }
    return { secret, source: "file" };
  }

  // No file yet. A legacy value migrates verbatim — this is a location
  // move, never a rotation. Only a genuinely fresh install (no env, no
  // file, no legacy value) is allowed to mint a new key.
  if (legacyValue) {
    writeSecretFile(secretPath, legacyValue);
    return { secret: legacyValue, source: "migrated" };
  }

  const generated = crypto.randomBytes(64).toString("hex");
  writeSecretFile(secretPath, generated);
  return { secret: generated, source: "generated" };
}

/**
 * Admin-triggered rotation: replace the file-based key with a brand new
 * one. Deliberately separate from loadOrCreateJwtSecret's migration path —
 * this always changes the value and therefore always invalidates every
 * existing access/refresh token. Callers must not use this when a
 * JWT_SECRET env override is active (env always wins on the next restart,
 * so rewriting the file would silently stop mattering) — see
 * services/auth.js regenerateJwtSecret() for that guard.
 */
export function regenerateJwtSecretFile() {
  const secretPath = getJwtSecretPath();
  const secret = crypto.randomBytes(64).toString("hex");
  writeSecretFile(secretPath, secret);
  return { secret, path: secretPath };
}
