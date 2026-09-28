/**
 * PanelBridge Auto-Install
 *
 * When the panel has local filesystem access to the PZ server's install
 * directory (bind mount, same-host install), PanelBridge.lua can be copied
 * into place automatically instead of requiring the user to do it by hand.
 * Remote/SFTP-managed servers are never touched here — the panel has no
 * local path to write to for those.
 *
 * installBridge() is the ONLY function in the panel that writes a loose
 * PanelBridge.lua into a game install, and services/bridgeDelivery.js is
 * its only caller (enforced by bridgeSingleWriterGate.test.js). Every
 * automatic path -- boot, activation, the before-launch hook, setup, the
 * manual Install button -- goes through bridgeDelivery.reconcileBridge(),
 * which first checks the server's PanelBridge delivery method: a game
 * folder whose servers get PanelBridge from the Steam Workshop must never
 * receive a loose copy (with DoLuaChecksum on, the loose copy alone makes
 * every join fail).
 *
 * Every function degrades to a clear `{ success: false, error }` rather than
 * throwing: install failures must never block server activation or launch.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareModVersions, getEmbeddedPanelBridgeLua, writeLuaAtomic } from '../utils/embeddedLua.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PanelBridgeInstaller');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION_REGEX = /VERSION\s*=\s*"([^"]+)"/;

// Dev checkout vs. packaged pkg binary layouts.
function sourceCandidates() {
  return [
    path.join(process.cwd(), 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
    path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
    path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
  ];
}

export function resolveSourcePath() {
  return sourceCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

// The server's install directory, resolved the same way serverManager does:
// prefer serverPath, fall back to installPath, and if that names a launch
// script (.bat/.sh/.exe) rather than a directory, use its parent folder.
// Shared by every caller that needs "this server's game folder" so none of
// them reimplements the extension check without the lowercasing below
// (bughunt-2026-08-31-c, launcher-extension-case-sensitivity).
export function resolveInstallDir(server) {
  let dir = server?.serverPath || server?.installPath;
  if (!dir) return null;
  const lower = dir.toLowerCase();
  if (lower.endsWith('.bat') || lower.endsWith('.sh') || lower.endsWith('.exe')) {
    dir = path.dirname(dir);
  }
  return dir;
}

export function resolveTargetPath(server) {
  const installDir = resolveInstallDir(server);
  return installDir ? path.join(installDir, 'media', 'lua', 'server', 'PanelBridge.lua') : null;
}

function isWritableDir(dirPath) {
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function canAutoInstall(server) {
  if (!server || server.isRemote) return false;
  const installDir = resolveInstallDir(server);
  if (!installDir || !fs.existsSync(installDir) || !isWritableDir(installDir)) {
    return false;
  }
  return Boolean(resolveSourcePath());
}

function extractVersion(content) {
  return (content.match(VERSION_REGEX) || [])[1] || null;
}

function readContent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    log.debug(`Could not read ${filePath}: ${error.message}`);
    return null;
  }
}

// The Lua this panel ships. The copy embedded in the binary at bundle time
// wins over the on-disk pz-mod/ tree: a binary-only auto-update leaves that
// tree stale, and only the embedded copy is guaranteed to match the running
// panel. Dev mode has no embedded copy and reads the checkout.
function readBundledSource() {
  const sourcePath = resolveSourcePath();
  const embedded = getEmbeddedPanelBridgeLua();
  if (embedded) return { content: embedded, sourcePath };
  return { content: sourcePath ? readContent(sourcePath) : null, sourcePath };
}

// needsUpdate is decided by comparing file CONTENT, not the hand-maintained
// VERSION label inside it. Three consecutive real bridge fixes (2026-08-31,
// operator-fix-the-three, json.decode/runEventSequence/stopWeather) shipped
// without a version bump, so a VERSION-only comparison silently reported
// "up to date" while the fixes never reached any server this gates. VERSION
// is kept only as a human-readable label on the returned status.
// Only the server file is compared: the panel no longer installs the client
// companion or a root mod.info (see installBridge()).
export function checkBridgeInstalled(server) {
  const { content: sourceContent, sourcePath } = readBundledSource();
  const targetPath = resolveTargetPath(server);
  const installed = Boolean(targetPath && fs.existsSync(targetPath));
  const targetContent = installed ? readContent(targetPath) : null;
  const needsUpdate = Boolean(
    installed && sourceContent !== null && (targetContent === null || targetContent !== sourceContent),
  );

  return {
    installed,
    version: targetContent ? extractVersion(targetContent) : null,
    needsUpdate,
    sourcePath,
    targetPath,
  };
}

// Best-effort: match the copied file's ownership to the install directory's
// so a game server process running as a different, unprivileged user can
// still read it. chown requires elevated privileges on most systems and
// doesn't exist at all on Windows, so failures here are logged, not thrown.
function matchOwnership(targetPath, referencePath) {
  if (process.platform === 'win32' || !referencePath) return;
  try {
    const { uid, gid } = fs.statSync(referencePath);
    fs.chownSync(targetPath, uid, gid);
  } catch (error) {
    log.debug(`Could not match ownership for ${targetPath}: ${error.message}`);
  }
}

// Writes ONLY media/lua/server/PanelBridge.lua. Older panels also wrote
// media/lua/client/PanelBridgeClient.lua and a root mod.info; neither ever
// did anything from the game install (the dedicated server hashes client/
// Lua but never runs it, players never receive loose files, and the game
// ignores a root mod.info), while both still broke DoLuaChecksum. The
// companion only runs when PanelBridge comes from the Steam Workshop.
// bridgeDelivery.reconcileBridge() archives those leftovers.
export function installBridge(server) {
  const { content: sourceContent } = readBundledSource();
  const targetPath = resolveTargetPath(server);
  if (!sourceContent) {
    return { success: false, error: 'PanelBridge source not found in panel install.' };
  }
  if (!targetPath) {
    return { success: false, error: 'Server install path not configured.' };
  }

  try {
    const sourceVersion = extractVersion(sourceContent);
    if (!sourceVersion) {
      return { success: false, error: 'PanelBridge source has no readable version.' };
    }
    if (fs.existsSync(targetPath)) {
      const targetContent = fs.readFileSync(targetPath, 'utf8');
      // Fast path: byte-identical already, regardless of what VERSION says.
      // A same-version-different-content install (the exact shape that let
      // three unbumped fixes go undelivered) still needs to fall through to
      // the write below -- only true content equality short-circuits here.
      if (targetContent === sourceContent) {
        return {
          success: true,
          targetPath,
          version: sourceVersion,
          updated: false,
          message: `Existing PanelBridge v${sourceVersion} already matches the bundled payload; left unchanged.`,
        };
      }
      const targetVersion = extractVersion(targetContent);
      if (targetVersion && compareModVersions(targetVersion, sourceVersion) > 0) {
        return {
          success: true,
          targetPath,
          version: targetVersion,
          updated: false,
          message: `Existing PanelBridge v${targetVersion} is newer than the bundled v${sourceVersion}; it was left unchanged.`,
        };
      }
    }
    writeLuaAtomic(targetPath, sourceContent);
    matchOwnership(targetPath, resolveInstallDir(server));
    const installedContent = fs.readFileSync(targetPath, 'utf8');
    const version = extractVersion(installedContent);
    if (installedContent !== sourceContent || version !== sourceVersion) {
      return { success: false, error: 'PanelBridge verification failed after install.' };
    }
    // Verifies the file the way the GAME will see it, not just the way the
    // panel's own (trivially-successful, same-process) read just did.
    // writeLuaAtomic() now enforces 0644 unconditionally, so this should
    // never actually fire -- it exists as a visible signal in case some
    // future change to that guarantee (or an unusual filesystem) silently
    // breaks it, rather than the mod just never loading with nothing in
    // the log to explain why (2026-08-29 Linux PanelBridge hunt).
    if (process.platform !== 'win32') {
      try {
        const { mode } = fs.statSync(targetPath);
        if ((mode & 0o004) === 0) {
          log.warn(
            `PanelBridge installed at ${targetPath}, but it is not world-readable ` +
              `(mode ${(mode & 0o777).toString(8)}). If the PZ server runs as a ` +
              'different user than the panel, it will not be able to load this mod.',
          );
        }
      } catch {
        /* best-effort */
      }
    }
    log.info(`PanelBridge installed at ${targetPath} (v${version || 'unknown'})`);
    return { success: true, targetPath, version, updated: true };
  } catch (error) {
    log.warn(`PanelBridge install failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// The version currently bundled with this panel install, independent of any
// per-server target. This is the only signal available for a remote/SFTP
// server: canAutoInstall()/checkBridgeInstalled() both require a local
// target path to compare content against, which a remote server has none of
// -- the panel never writes its files. All a remote status check can do is
// compare the mod's own self-reported live VERSION (PanelBridge.lua reports
// PanelBridge.VERSION every tick via status.json) against this. Embedded
// copy first, for the same reason as readBundledSource().
export function getBundledBridgeVersion() {
  const { content } = readBundledSource();
  return content ? extractVersion(content) : null;
}

// True when a live, self-reported bridge version is older than what this
// panel currently bundles. String comparison is the only signal available
// for a remote server -- see getBundledBridgeVersion() above.
export function isBridgeVersionBehindBundled(liveVersion) {
  const bundled = getBundledBridgeVersion();
  if (!bundled || !liveVersion) return false;
  return compareModVersions(liveVersion, bundled) < 0;
}
