/**
 * Routes server lifecycle actions to Docker when the target server is mapped
 * to a managed container.
 *
 * Why this exists: RCON `quit` and `serverManager.stopServer()` both act on the
 * *process*. Inside a container that process is PID 1, so killing it exits the
 * container — and a `restart: always` / `unless-stopped` policy immediately
 * brings the world back up. From the operator's seat the Stop button looks
 * broken. `docker stop` is a *manual* stop, which Docker exempts from restart
 * policies, so it is the only shutdown that actually sticks.
 *
 * Every caller keeps its own RCON save + guards; this module only decides who
 * owns the lifecycle action and performs the Docker half.
 */
import { getActiveServer, getServer } from "../database/init.js";
import {
  notifyServerLaunched,
  prepareForLaunch,
} from "./lifecycleCoordinator.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ManagedContainer");

// Wired once from index.js. Routes may still pass an explicit client.
let sharedDockerClient = null;
const containerLifecycleQueues = new WeakMap();

export function setDockerClient(client) {
  sharedDockerClient = client || null;
}

export function getDockerClient() {
  return sharedDockerClient;
}

/**
 * What a container's inspect State says, without trusting State.Running alone:
 * Docker keeps Running === true for a paused container and for one waiting out
 * a restart policy between crashes ("restarting"), so a crash-looping
 * `restart: always` container and a paused one both read as running.
 *
 *  - running: up and serving, Running and neither paused nor restarting.
 *  - alive: has something to stop (Running, however it is doing) -- a stop
 *    still has work to do for a paused or restarting container.
 *  - state: "paused" or "restarting" when that is why it is not running,
 *    otherwise null.
 */
export function describeContainerState(container) {
  const state = container?.State || {};
  const alive = state.Running === true;
  const paused = alive && (state.Paused === true || state.Status === "paused");
  const restarting = alive && !paused && (state.Restarting === true || state.Status === "restarting");
  return {
    running: alive && !paused && !restarting,
    alive,
    state: paused ? "paused" : restarting ? "restarting" : null,
  };
}

async function acquireContainerLifecycleLock(dockerClient, ref) {
  let queues = containerLifecycleQueues.get(dockerClient);
  if (!queues) {
    queues = new Map();
    containerLifecycleQueues.set(dockerClient, queues);
  }

  const previous = queues.get(ref) || Promise.resolve();
  let releaseSignal;
  const current = new Promise((resolve) => {
    releaseSignal = resolve;
  });
  queues.set(ref, current);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (queues.get(ref) === current) queues.delete(ref);
    releaseSignal();
  };
}

/**
 * @returns {Promise<{handled: boolean, ref?: string, container?: object|null,
 *   running?: boolean, error?: string}>}
 *   `handled: false` means no managed container owns this server — the caller
 *   must fall back to its existing RCON/process path.
 */
export async function resolveManagedContainer({
  serverId = null,
  dockerClient = sharedDockerClient,
} = {}) {
  if (!dockerClient?.enabled || !dockerClient.available) return { handled: false };

  let server = null;
  try {
    server = serverId == null ? await getActiveServer() : await getServer(serverId);
  } catch (error) {
    log.debug(`Could not resolve the server profile: ${error.message}`);
    return { handled: false };
  }

  const ref = server?.dockerContainerName || server?.dockerContainerId || null;
  if (!ref) return { handled: false };

  const container = await dockerClient.inspectManagedContainer(ref);
  if (!container) {
    // Fail closed. Falling back to RCON here would kill the game process and
    // let the container's restart policy bring it straight back up — the exact
    // failure this module exists to prevent.
    return {
      handled: true,
      ref,
      container: null,
      error:
        `Container "${ref}" is mapped to this server but the panel cannot manage it. ` +
        `Check that it exists and carries the label zomboid-panel.managed=true.`,
    };
  }

  const { running, alive, state } = describeContainerState(container);
  return {
    handled: true,
    ref,
    container,
    running,
    alive,
    ...(state ? { containerState: state } : {}),
  };
}

/**
 * Docker-aware "is the host up" signal for docker-local/docker-managed
 * providers. Callers must already know the server IS a Docker provider
 * (see resolveProvider() in server/utils/serverStatusModel.js) -- this
 * does not check that itself, and a native/systemd/openrc/remote server
 * passed in here would just fall through to the resolveManagedContainer()
 * branch and report `scanFailed: true` (no container ref to look up).
 *
 * Mirrors the two Docker paths server/routes/serverStatus.js's GET
 * /active/status route used to inline directly, kept here as the ONE
 * implementation so that route's dashboard badge and the status watchdog
 * (server/index.js's checkServerStatusNow) can never drift out of sync on
 * what "Docker says running" means for the same server at the same
 * moment. Both paths ultimately call dockerClient.inspectManagedContainer(),
 * which unconditionally requires the zomboid-panel.managed=true label
 * itself (see isManagedContainer() above) -- there is no unlabeled-container
 * path. The two branches differ only in HOW the container ref is found:
 *  - if the given `server` already carries a usable ref (dockerContainerName
 *    /dockerContainerId) and dockerClient looks usable, inspect it directly.
 *  - otherwise fall through to resolveManagedContainer(), which re-resolves
 *    the server record itself (by id) and produces a more specific error
 *    when Docker control is off/unavailable or nothing is mapped.
 *
 * @returns {Promise<{running: boolean, scanFailed: boolean}>} scanFailed
 *   true means "could not verify" (Docker control off/unavailable, the
 *   lookup itself failed, or a mapped container/ref that no longer
 *   resolves) -- callers must treat that as unknown, never as a confident
 *   "stopped" (GH#114: PZ runs as PID 1 of a *different* container here,
 *   so there is no local fallback that could ever safely stand in).
 */
export async function resolveDockerHostSignal(
  server,
  dockerClient = sharedDockerClient,
) {
  const containerRef = server?.dockerContainerName || server?.dockerContainerId;
  if (
    containerRef &&
    dockerClient?.enabled &&
    dockerClient.available &&
    typeof dockerClient.inspectManagedContainer === "function"
  ) {
    const container = await dockerClient.inspectManagedContainer(containerRef);
    return container
      ? runningContainerSignal(container)
      : { running: false, scanFailed: true };
  }

  const managed = await resolveManagedContainer({
    serverId: server?.id,
    dockerClient,
  });
  if (managed.handled) {
    return managed.error
      ? { running: false, scanFailed: true }
      : runningContainerSignal(managed.container);
  }
  return { running: false, scanFailed: true };
}

// The container's own State.StartedAt -- already in the inspect result both
// paths above just fetched, so no extra Docker API cost. It is when the
// CONTAINER started: the game server's start as long as PZ runs as the
// container's main process and isn't relaunched inside it (an operator's
// own docker-local image may loop PZ in its entrypoint, where this is
// container uptime instead). It is still the only start time the panel can
// state here -- its local process scan (and so serverManager.
// resolveStartTime()) never sees that process. Carried only while running;
// the status model validates it (see resolveHostStartedAt() in
// serverStatusModel.js).
function runningContainerSignal(container) {
  const { running, state } = describeContainerState(container);
  const startedAt = running ? container.State.StartedAt : null;
  return {
    running,
    scanFailed: false,
    // Why a container that Docker still calls running is not serving: shown
    // as the host detail instead of a plain "Container running" (or nothing).
    ...(state ? { containerState: state } : {}),
    ...(typeof startedAt === "string" && startedAt ? { startedAt } : {}),
  };
}

/**
 * @param {"start"|"stop"|"restart"} action
 * @returns {Promise<{handled: boolean, success?: boolean, message?: string, error?: string}>}
 */
export async function runManagedLifecycle(
  action,
  { serverId = null, dockerClient = sharedDockerClient } = {},
) {
  const resolved = await resolveManagedContainer({ serverId, dockerClient });
  if (!resolved.handled) return { handled: false };
  if (resolved.error) return { handled: true, success: false, error: resolved.error };

  const release = await acquireContainerLifecycleLock(dockerClient, resolved.ref);
  try {
    const current = await resolveManagedContainer({ serverId, dockerClient });
    if (!current.handled) {
      return {
        handled: true,
        success: false,
        error: "Docker control became unavailable while the lifecycle action was waiting",
      };
    }
    if (current.error) {
      return { handled: true, success: false, error: current.error };
    }

    // A paused or restarting container still has a process for `docker stop`
    // to end, so only one that is not running at all counts as stopped.
    if (action === "stop" && !current.alive) {
      return { handled: true, success: true, message: "Container is already stopped" };
    }
    if (action === "start" && current.containerState === "paused") {
      // `docker start` refuses a paused container, and answering "already
      // running" for one that is frozen would hide that.
      return {
        handled: true,
        success: false,
        error: `Container "${current.ref}" is paused. Unpause it (docker unpause ${current.ref}) or stop it, then start it again.`,
      };
    }
    if (action === "start" && current.running) {
      return {
        handled: true,
        success: true,
        alreadyRunning: true,
        message: "Container is already running",
      };
    }

    // The before-launch step (lifecycleCoordinator.prepareForLaunch()): the
    // container start IS the launch for a Docker-managed server, so this is
    // the last moment an ini change (the server's current RCON password) or
    // a bridge file can reach it. Callers used to refresh RCON only after
    // this function returned -- after `docker start`/`docker restart` had
    // already booted the game against the old ini. The image owns the launch
    // command, so no script is written. The record lookup is inside the same
    // never-blocks guarantee as the step itself.
    let target = null;
    let launchSeq = null;
    if (action === "start" || action === "restart") {
      target = await Promise.resolve()
        .then(() => (serverId ? getServer(serverId) : getActiveServer()))
        .catch(() => null);
      ({ launchSeq } = await prepareForLaunch(target, { container: true }));
    }

    const result = await dockerClient.runManagedAction(current.ref, action);
    log.info(
      `Managed container ${current.ref}: ${action} -> ${result?.success ? "ok" : result?.error || "failed"}`,
    );
    // The container (re)start launched the game -- unless Docker answered
    // that it was already in that state (GH #189).
    if (launchSeq !== null && result?.success && !result.unchanged) {
      notifyServerLaunched(target, launchSeq);
    }
    return { handled: true, ...result };
  } finally {
    release();
  }
}
