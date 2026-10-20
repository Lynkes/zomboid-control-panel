/**
 * Tells the container HEALTHCHECK (docker/healthcheck.cjs) which port the
 * panel really listens on. That is PORT, else the port saved in Settings,
 * else 3001 -- or a free port the panel picked because that one was busy --
 * so only the running process knows it. A healthcheck fixed on 3001 read a
 * panel on any other port as unhealthy, and the all-in-one updater rolls an
 * update back on "unhealthy".
 *
 * Only when PANEL_PORT_FILE is set (both Docker images set it), and best
 * effort: a failed write leaves the healthcheck on PORT or 3001.
 */
import fs from "fs";

export function recordPanelPort(port, { env = process.env, log = null } = {}) {
  const file = env.PANEL_PORT_FILE;
  if (!file || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  // Written beside it and renamed, so the healthcheck never reads half a file.
  const temp = `${file}.${process.pid}.tmp`;
  try {
    // codeql[js/path-injection] PANEL_PORT_FILE is the operator's own container environment (the Dockerfiles set it to /tmp/zomboid-panel.port); only a port number is written.
    fs.writeFileSync(temp, `${port}\n`, { mode: 0o644 });
    // codeql[js/path-injection] same operator-set path as above.
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing left to clean up */
    }
    log?.warn?.(`Could not record the panel port in ${file}: ${error.message}`);
    return false;
  }
}
