import { createLogger } from "../utils/logger.js";
import { SourceRconClient } from "../utils/sourceRcon.js";
import { waitForProcessExit } from "../utils/processScanRetry.js";

const log = createLogger("ContainerShutdown");

// In the all-in-one image the game servers are children of the panel's own
// container: the panel spawns them detached, but in the same PID namespace.
// `docker stop`, `docker compose down`, a host reboot and a Watchtower
// recreate all end the container the same way -- SIGTERM to the panel, then
// SIGKILL to whatever is still alive once the stop timeout is over -- so a
// JVM the panel did not stop itself loses everything since its last save.
//
// The budget for save + quit + exit. It has to stay under the compose file's
// `stop_grace_period` (120 s) with room for the rest of the panel's shutdown.
export const CONTAINER_SHUTDOWN_BUDGET_MS = 90 * 1000;
const POLL_INTERVAL_MS = 2000;
const PROGRESS_LOG_EVERY_POLLS = 5;

/** True inside the all-in-one image (its Dockerfile sets PANEL_ALL_IN_ONE). */
export function isAllInOneContainer(env = process.env) {
  return String(env?.PANEL_ALL_IN_ONE || "").toLowerCase() === "true";
}

/**
 * Saves and quits one game server over a throwaway RCON connection: for the
 * servers the panel holds no RCON connection to (every server but the active
 * one). `quit` saves too, so it is sent even when `save` fails or times out.
 * A quit that is not answered, or whose connection drops, is the server
 * exiting; only a command that never left this process counts as a failure.
 */
export async function saveAndQuitOverRcon({
  host,
  port,
  password,
  timeoutMs = 5000,
  saveTimeoutMs = 30000,
} = {}) {
  const client = new SourceRconClient({ host, port, timeout: timeoutMs });
  try {
    try {
      await client.authenticate(password || "");
    } catch (err) {
      return { success: false, error: err?.message || "connection failed" };
    }
    try {
      const reply = await client.execute("save", { timeoutMs: saveTimeoutMs });
      log.debug(`RCON save on ${host}:${port}: ${String(reply).trim().slice(0, 80)}`);
    } catch (err) {
      if (err?.rconNeverSent) {
        return { success: false, error: err.message };
      }
      log.warn(`RCON save on ${host}:${port} did not finish (${err?.message}); sending quit anyway`);
    }
    try {
      const reply = await client.execute("quit", { timeoutMs });
      log.debug(`RCON quit on ${host}:${port}: ${String(reply).trim().slice(0, 80)}`);
    } catch (err) {
      if (err?.rconNeverSent) {
        return { success: false, error: err.message };
      }
    }
    return { success: true };
  } finally {
    client.disconnect();
  }
}

function describeServer(server) {
  return server?.name || server?.serverName || server?.id || "server";
}

// The panel's own RCON connection (the active server): `quit` saves too, so a
// failed `save` does not stop it.
async function stopViaPanelRcon(rconService, label) {
  const saved = await rconService.save();
  if (!saved?.success) {
    log.warn(`${label}: save failed (${saved?.error || "unknown error"}); sending quit anyway, which saves too`);
  }
  const quit = await rconService.quit();
  if (!quit?.success) {
    return { success: false, error: quit?.error || "quit failed" };
  }
  return { success: true };
}

/**
 * Saves the world and quits every game server running in this container, then
 * waits (bounded) for the processes to exit. Never throws: a failure is
 * logged and shutdown goes on, since the container is going down either way.
 *
 * The active server goes through the panel's own RCON connection; any other
 * server through a throwaway one with the credentials stored in its profile.
 * Processes that cannot be tied to a profile are only reported.
 */
export async function saveAndStopLocalServers({
  rconService,
  serverManager,
  getActiveServer,
  findOtherRunningServers,
  scanHost,
  stopOverRcon = saveAndQuitOverRcon,
  budgetMs = CONTAINER_SHUTDOWN_BUDGET_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  sleep,
} = {}) {
  const startedAt = Date.now();
  const elapsedSeconds = () => Math.round((Date.now() - startedAt) / 1000);
  const outcome = { attempted: 0, stopped: false, timedOut: false };

  try {
    let active = null;
    try {
      active = await getActiveServer();
    } catch (err) {
      log.warn(`Could not read the active server: ${err.message}`);
    }

    // Who is running. A failed scan is "don't know": an RCON connection to
    // the active server still proves it is there.
    let activeRunning = false;
    try {
      const details = await serverManager.getServerProcessDetails();
      activeRunning = details?.scanFailed
        ? Boolean(rconService?.connected)
        : Boolean(details?.running);
    } catch (err) {
      activeRunning = Boolean(rconService?.connected);
      log.warn(`Could not check whether the active server is running: ${err.message}`);
    }
    let others = { servers: [], unattributed: [] };
    try {
      const found = await findOtherRunningServers(active);
      if (found?.scanFailed) {
        log.warn("Process detection failed, so servers other than the active one could not be listed");
      } else {
        others = found;
      }
    } catch (err) {
      log.warn(`Could not list the other running servers: ${err.message}`);
    }
    for (const entry of others.unattributed || []) {
      log.warn(`PID ${entry.pid} looks like a Project Zomboid server but belongs to no profile, so the panel cannot save it`);
    }

    const jobs = [];
    if (activeRunning && (active || rconService?.connected)) {
      const label = active ? describeServer(active) : "active server";
      jobs.push(
        (async () => {
          if (rconService?.connected) return stopViaPanelRcon(rconService, label);
          if (!active?.rconPort) {
            return { success: false, error: "RCON is not connected and no RCON port is configured" };
          }
          return stopOverRcon({
            host: active.rconHost || "127.0.0.1",
            port: Number(active.rconPort),
            password: active.rconPassword || "",
          });
        })().then((result) => ({ label, ...result })),
      );
    }
    for (const server of others.servers || []) {
      const label = describeServer(server);
      jobs.push(
        (async () => {
          if (!server.rconPort) {
            return { success: false, error: "no RCON port is configured" };
          }
          return stopOverRcon({
            host: server.rconHost || "127.0.0.1",
            port: Number(server.rconPort),
            password: server.rconPassword || "",
          });
        })().then((result) => ({ label, ...result })),
      );
    }

    if (jobs.length === 0) {
      log.info("No game server is running in this container");
      outcome.stopped = true;
      return outcome;
    }

    outcome.attempted = jobs.length;
    log.info(`Saving and stopping ${jobs.length} game server(s) before the container exits...`);
    // Bounded like the wait below: a save that never answers must not use up
    // the whole grace period.
    let sendTimer = null;
    const results = await Promise.race([
      Promise.all(
        jobs.map((job) =>
          job.catch((err) => ({ label: "server", success: false, error: err?.message })),
        ),
      ),
      new Promise((resolve) => {
        sendTimer = setTimeout(() => resolve([]), Math.max(0, budgetMs - (Date.now() - startedAt)));
      }),
    ]).finally(() => clearTimeout(sendTimer));
    if (results.length === 0) {
      log.warn(`The save and quit commands did not finish within ${Math.round(budgetMs / 1000)}s`);
    }
    for (const result of results) {
      if (result.success) {
        log.info(`${result.label}: save and quit sent`);
      } else {
        log.warn(`${result.label}: could not be stopped over RCON (${result.error || "unknown error"})`);
      }
    }

    // The server is on its way out: don't let the panel's RCON keep trying to
    // reconnect to it while the wait below runs.
    try {
      rconService?.stopAutoReconnect?.();
    } catch {
      /* best effort */
    }

    // Wait for every Project Zomboid process on the host to be gone.
    let polls = 0;
    const read = async () => {
      polls += 1;
      const scan = await scanHost();
      if (!scan || scan.scanFailed) return { running: false, scanFailed: true };
      const count = Array.isArray(scan.matched) ? scan.matched.length : 0;
      if (count > 0 && polls % PROGRESS_LOG_EVERY_POLLS === 0) {
        log.info(`Waiting for ${count} game server process(es) to exit (${elapsedSeconds()}s of ${Math.round(budgetMs / 1000)}s)...`);
      }
      return { running: count > 0, scanFailed: false };
    };
    const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt));
    const finalState = await waitForProcessExit(read, {
      polls: Math.ceil(remainingMs / pollIntervalMs) + 1,
      intervalMs: pollIntervalMs,
      maxElapsedMs: remainingMs,
      context: "Container shutdown",
      ...(sleep ? { sleep } : {}),
    });

    if (!finalState.scanFailed && !finalState.running) {
      outcome.stopped = true;
      log.info(`Game server(s) exited after ${elapsedSeconds()}s`);
    } else {
      outcome.timedOut = true;
      log.warn(
        finalState.scanFailed
          ? `Process detection could not confirm the game server(s) exited after ${elapsedSeconds()}s; shutting down anyway`
          : `Game server process(es) were still running after ${elapsedSeconds()}s; shutting down anyway, Docker will stop them`,
      );
    }
  } catch (err) {
    log.error(`Could not save and stop the game servers: ${err.message}`);
  }
  return outcome;
}
