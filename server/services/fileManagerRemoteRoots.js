// Remote Server Files roots (spec §A3.1): which folders of the active remote
// profile the file manager may open over the panel's PanelBridge SFTP login.
//
// The SFTP settings are panel-wide keys, not per profile, so only the ACTIVE
// remote profile is browsable. The operator's manual folders live in
// settings.fileManagerRemoteRoots, keyed by "<host>:<port>:<username>": a
// stale override written for one server never applies to a different one.
//
// Pure: no network, no settings writes. The service calls this for a
// remote-sftp profile and for PUT /remote-roots; the SFTP backend opens the
// RootSpecs it returns.
import { posix } from "path";
import { ErrorCode } from "../utils/errorCodes.js";
import { FmError } from "./fileManagerContract.js";
import { SFTP_CONFIG_PATH_KEY } from "./remoteConfigFiles.js";

// Same cap as the bridge and config-mirror paths (panelBridgeSftp.js,
// remoteConfigFiles.js), and checked before anything else looks at the value.
const MAX_REMOTE_ROOT_PATH_LENGTH = 500;

const OVERRIDES_SETTING_KEY = "fileManagerRemoteRoots";

// Any C0 control character or DEL. The spec names NUL, CR and LF; the rest
// have no business in a folder the operator types either.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * A root the SFTP backend is asked to open. `unavailable` is set instead of
 * `path` when this one root can't be offered (install with no folder set, or
 * a Zomboid folder that can't be derived); the backend's describeRoot()
 * turns such a spec into an unavailable RootDescriptor without connecting.
 * @typedef {Object} RemoteRootSpec
 * @property {import("./fileManagerContract.js").RootId} id
 * @property {string|null} path
 * @property {import("./fileManagerContract.js").RootWarning[]} warnings
 * @property {{ reason: import("./fileManagerContract.js").RootUnavailableReason, detail?: string }} [unavailable]
 */

function invalidPath(reason) {
  return new FmError(ErrorCode.FM_INVALID_PATH, undefined, { reason });
}

/**
 * Validate and normalize a remote folder: an absolute POSIX path of at most
 * 500 characters with no ".." segment, backslash or control character.
 * "." segments, repeated slashes and a trailing slash are normalized away.
 * "/" is accepted only with `allowSlash` (an operator typing it explicitly).
 * null, undefined and "" mean "not set" and return null.
 * @param {unknown} p
 * @param {{ allowSlash?: boolean }} [opts]
 * @returns {string|null}
 * @throws {FmError} FM_INVALID_PATH with params.reason
 */
export function validateRemoteRootPath(p, { allowSlash = false } = {}) {
  if (p === null || p === undefined || p === "") return null;
  if (typeof p !== "string") throw invalidPath("empty");
  if (p.length > MAX_REMOTE_ROOT_PATH_LENGTH) throw invalidPath("tooLong");
  if (CONTROL_CHAR_RE.test(p)) throw invalidPath("control");
  if (p.includes("\\")) throw invalidPath("backslash");
  if (!p.startsWith("/")) throw invalidPath("notAbsolute");
  if (p.split("/").includes("..")) throw invalidPath("dotSegment");
  // No ".." is left, so normalize() only drops "." and empty segments; it
  // can't climb.
  const normalized = posix.normalize(p);
  const trimmed = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (trimmed === "/" && !allowSlash) throw invalidPath("filesystemRoot");
  return trimmed;
}

// The same check, for values the panel derives rather than the operator
// types: anything unusable (including "/") simply isn't a candidate.
function optionalRemotePath(p) {
  try {
    return validateRemoteRootPath(p, { allowSlash: false });
  } catch {
    return null;
  }
}

// True when `child` is `parent` itself or somewhere below it. Both are
// normalized absolute POSIX paths.
function isSameOrInside(parent, child) {
  if (parent === child) return true;
  const prefix = parent === "/" ? "/" : `${parent}/`;
  return child.startsWith(prefix);
}

/**
 * "<host>:<port>:<username>" for the current SFTP login, or null when no host
 * is set. Keys settings.fileManagerRemoteRoots, so PUT /remote-roots writes
 * the override under the same key this module reads it from.
 * @param {Record<string, unknown>} settings
 * @returns {string|null}
 */
export function getRemoteRootsKey(settings) {
  const host = typeof settings?.panelBridgeSftpHost === "string" ? settings.panelBridgeSftpHost.trim() : "";
  if (!host) return null;
  const username = typeof settings?.panelBridgeSftpUsername === "string" ? settings.panelBridgeSftpUsername.trim() : "";
  const port = Number(settings?.panelBridgeSftpPort || 22);
  return `${host}:${port}:${username}`;
}

/**
 * The operator's folders for the current login. An entry that fails
 * validation counts as not set, so a hand-edited db.json can't smuggle in a
 * relative path or a "..".
 * @returns {{ installPath: string|null, dataPath: string|null }}
 */
function readOverride(settings, key) {
  const all = settings?.[OVERRIDES_SETTING_KEY];
  const entry =
    key && all && typeof all === "object" && !Array.isArray(all) && Object.prototype.hasOwnProperty.call(all, key)
      ? all[key]
      : null;
  if (!entry || typeof entry !== "object") return { installPath: null, dataPath: null };
  const pick = (value) => {
    try {
      return validateRemoteRootPath(value, { allowSlash: true });
    } catch {
      return null;
    }
  };
  return { installPath: pick(entry.installPath), dataPath: pick(entry.dataPath) };
}

// The Zomboid folder the panel can work out on its own, before any override:
// the parent of a Server/ config folder, else the bridge folder minus its
// trailing Lua/panelbridge/<server>. Hosting providers differ in case
// ("/server-data/lua/panelbridge/<name>" on some chrooted hosts), so that
// match ignores case.
function deriveDataPath(configPath, bridgePath) {
  if (configPath && posix.basename(configPath) === "Server") {
    const parent = posix.dirname(configPath);
    if (parent !== "/") return parent;
  }
  if (bridgePath) {
    const segments = bridgePath.split("/");
    const n = segments.length;
    if (
      n >= 5 &&
      segments[n - 3].toLowerCase() === "lua" &&
      segments[n - 2].toLowerCase() === "panelbridge" &&
      segments[n - 1] !== ""
    ) {
      const parent = segments.slice(0, n - 3).join("/");
      if (parent && parent !== "/") return parent;
    }
  }
  return null;
}

function rootSpec(id, path, warnings = []) {
  return { id, path, warnings };
}

function unavailableSpec(id, reason) {
  return { id, path: null, warnings: [], unavailable: { reason } };
}

/**
 * Work out the remote roots of a remote-sftp profile (spec §A3.1).
 *
 * - Not the active profile: `unavailable: { reason: "remoteNotActive" }`, no roots.
 * - Active, but no SFTP host (or an unusable login): "remoteNotConfigured", no roots.
 * - Otherwise `roots` lists install, data and config in ROOT_IDS order:
 *   - install: the override only, else unavailable "remoteInstallNotSet";
 *   - data: the override, else derived from the config folder or the bridge
 *     folder, else unavailable "remoteNotConfigured";
 *   - config: panelBridgeSftpConfigPath, left out when it is data or inside
 *     it (it's then a bookmark into data).
 * - An explicit "/" carries the warning "remoteFilesystemRoot"; a derived
 *   "/" is never offered.
 *
 * @param {{ profile?: object, settings: Record<string, unknown>, isActive: boolean }} args
 * @returns {{
 *   roots: RemoteRootSpec[],
 *   unavailable?: { reason: import("./fileManagerContract.js").RootUnavailableReason, detail?: string },
 *   remote: { host: string, port: number, username: string }|null,
 *   derivedDataPath: string|null,
 *   overrides: { installPath: string|null, dataPath: string|null },
 *   key: string|null,
 * }}
 */
export function resolveRemoteRoots({ settings, isActive } = {}) {
  const key = getRemoteRootsKey(settings);
  const remote = key
    ? {
        host: String(settings.panelBridgeSftpHost).trim(),
        port: Number(settings.panelBridgeSftpPort || 22),
        username: typeof settings.panelBridgeSftpUsername === "string" ? settings.panelBridgeSftpUsername.trim() : "",
      }
    : null;
  const overrides = readOverride(settings, key);
  const configPath = optionalRemotePath(settings?.[SFTP_CONFIG_PATH_KEY]);
  const bridgePath = optionalRemotePath(settings?.panelBridgeSftpBridgePath);
  const derivedDataPath = deriveDataPath(configPath, bridgePath);
  const base = { remote, derivedDataPath, overrides, key };

  if (!isActive) {
    return { ...base, roots: [], unavailable: { reason: "remoteNotActive" } };
  }
  if (!remote || !remote.username) {
    return { ...base, roots: [], unavailable: { reason: "remoteNotConfigured" } };
  }

  const withRootWarning = (path) => (path === "/" ? ["remoteFilesystemRoot"] : []);
  const roots = [];

  roots.push(
    overrides.installPath
      ? rootSpec("install", overrides.installPath, withRootWarning(overrides.installPath))
      : unavailableSpec("install", "remoteInstallNotSet"),
  );

  const dataPath = overrides.dataPath || derivedDataPath;
  roots.push(
    dataPath ? rootSpec("data", dataPath, withRootWarning(dataPath)) : unavailableSpec("data", "remoteNotConfigured"),
  );

  if (configPath && !(dataPath && isSameOrInside(dataPath, configPath))) {
    roots.push(rootSpec("config", configPath));
  }

  return { ...base, roots };
}
