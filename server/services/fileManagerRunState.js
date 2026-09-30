// Is a server running, for the Server Files gates (spec §A5.5)? Composed
// from the same signals the status page uses, per provider, without
// touching routes/servers.js:
//   remote-sftp               -> unknown (the panel can't see the host)
//   docker-local/-managed     -> the managed container's state
//   systemd/openrc            -> the service unit's state
//   native, active profile    -> the shared ServerManager's process check
//   native, other profiles    -> a host scan attributed by -servername/-cachedir
// Anything that couldn't be verified is "unknown", never a confident
// "stopped": unknown asks the operator to confirm, stopped doesn't.
import { resolveProvider } from "../utils/serverStatusModel.js";
import { resolveDockerHostSignal } from "./managedContainer.js";
import { createLinuxServiceLifecycle, isManagedLifecycleProvider } from "./linuxServiceLifecycle.js";
import { ServerManager, scoreServerProcessOwnership } from "./serverManager.js";
import { createLogger } from "../utils/logger.js";
import { FM_LIMITS } from "./fileManagerContract.js";

const log = createLogger("FileManager:RunState");

const defaultDeps = {
  resolveDockerHostSignal,
  createLinuxServiceLifecycle,
  createServerManager: () => new ServerManager(),
  now: () => Date.now(),
};
let deps = { ...defaultDeps };

/** @type {Map<string, { state: string, at: number }>} */
const cache = new Map();

// Test seams: swap the signal sources, clear the 5 s cache.
export function _setRunStateDepsForTests(overrides = {}) {
  deps = { ...defaultDeps, ...overrides };
  cache.clear();
}

export function _resetRunStateCacheForTests() {
  cache.clear();
}

async function computeRunState(profile, app) {
  const provider = resolveProvider(profile);
  if (provider === "remote-sftp") return "unknown";

  if (provider === "docker-local" || provider === "docker-managed") {
    const signal = await deps.resolveDockerHostSignal(profile, app?.get?.("dockerClient"));
    if (!signal || signal.scanFailed) return "unknown";
    return signal.running ? "running" : "stopped";
  }

  if (isManagedLifecycleProvider(profile.lifecycleProvider)) {
    const status = await deps.createLinuxServiceLifecycle(profile, profile.lifecycleProvider).status();
    if (!status || status.scanFailed) return "unknown";
    return status.running ? "running" : "stopped";
  }

  if (profile.isActive) {
    const manager = app?.get?.("serverManager");
    if (!manager || typeof manager.getServerProcessDetails !== "function") return "unknown";
    const details = await manager.getServerProcessDetails();
    if (!details || details.scanFailed) return "unknown";
    return details.running ? "running" : "stopped";
  }

  const scan = await deps.createServerManager().scanHostForServerProcesses();
  if (!scan || scan.scanFailed) return "unknown";
  const descriptor = {
    serverName: profile.serverName,
    savePath: profile.zomboidDataPath,
    serverPath: profile.serverPath || profile.installPath,
  };
  const owned = (scan.matched || []).some((m) => scoreServerProcessOwnership(m.cmd, descriptor) > 0);
  return owned ? "running" : "stopped";
}

/**
 * @param {object} profile  a server record from getServer()
 * @param {import("express").Application} app  for the shared ServerManager and Docker client
 * @param {{ fresh?: boolean }} [opts]  fresh bypasses the 5 s cache
 * @returns {Promise<"running"|"stopped"|"unknown">}
 */
export async function getRunState(profile, app, { fresh = false } = {}) {
  if (!profile) return "unknown";
  const key = String(profile.id);
  const now = deps.now();
  const cached = cache.get(key);
  if (!fresh && cached && now - cached.at < FM_LIMITS.RUNSTATE_CACHE_MS) return cached.state;
  let state;
  try {
    state = await computeRunState(profile, app);
  } catch (err) {
    log.warn(`Run state check failed for server ${key}: ${err?.code || err?.name || "error"}`);
    state = "unknown";
  }
  cache.set(key, { state, at: deps.now() });
  return state;
}

/**
 * The state of a folder several profiles share (an install or launch
 * folder): running if any of them runs, else unknown if any is unknown.
 */
export async function getSharedRunState(profiles, app, opts) {
  const states = await Promise.all((profiles || []).map((p) => getRunState(p, app, opts)));
  if (states.includes("running")) return "running";
  if (states.includes("unknown")) return "unknown";
  return "stopped";
}
