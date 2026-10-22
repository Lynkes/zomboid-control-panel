import fs from "fs";
import net from "net";

// Secondary proof that a local server is stopped, asked ONLY when the process
// scan can't answer (scanFailed). A 1.5.0 support bundle: every Windows scan
// failed, so Start stayed refused and a scheduled restart quit the server and
// never started it again. The process scan stays the authority; this only
// settles its "don't know", and only on two independent signs together:
//
// 1. The RCON port REFUSES a TCP connection (ECONNREFUSED: nothing listens).
//    A timeout or any other error proves nothing. Never enough alone: RCON
//    can be disabled or pointed at the wrong port.
// 2. The game's console log (server-console.txt, rewritten at every start)
//    ends the run: the JVM shutdown hook (zombie.network.GameServer$1, read
//    from the 42.21 jar) prints "Shutdown handling started", "Server exited",
//    saves the world, then "Shutdown handling finished" right before the JVM
//    halts. A log that merely went quiet proves nothing: a server hung while
//    saving looks the same, and two servers on one world corrupt its save.
export const SHUTDOWN_FINISHED_LINE = "Shutdown handling finished";
const SHUTDOWN_STARTED_RE = /Shutdown handling started|Server exited/;

// The log must have been quiet this long: the JVM halts right after
// "finished", while after "started" the world may still be saving.
export const QUIET_AFTER_FINISHED_MS = 3_000;
export const QUIET_AFTER_SHUTDOWN_STARTED_MS = 30_000;
export const CONSOLE_TAIL_BYTES = 64 * 1024;
// Windows retries a refused localhost connection for about 2 s before it
// reports ECONNREFUSED.
export const RCON_PROBE_TIMEOUT_MS = 5_000;

/** "open", "refused" or "unknown" for a TCP connect to host:port. */
export function probeTcpPort(host, port, timeoutMs = RCON_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve("unknown");
      return;
    }
    const socket = new net.Socket();
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("open"));
    socket.once("timeout", () => done("unknown"));
    socket.once("error", (error) => done(error?.code === "ECONNREFUSED" ? "refused" : "unknown"));
    try {
      socket.connect(port, host);
    } catch {
      done("unknown");
    }
  });
}

/** The last CONSOLE_TAIL_BYTES of a log and its mtime, or null. */
export function readConsoleTail(filePath, maxBytes = CONSOLE_TAIL_BYTES) {
  if (!filePath) return null;
  let fd = null;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, length, stats.size - length);
    return { text: buffer.toString("utf8"), mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

const seconds = (ms) => Math.round(ms / 1000);

/**
 * Pure verdict. `rcon` is probeTcpPort()'s answer, `consoleLog` is
 * readConsoleTail()'s. Resolves to { stopped, reason }.
 */
export function evaluateStoppedEvidence({ rcon, consoleLog, now = Date.now() }) {
  if (rcon !== "refused") {
    return {
      stopped: false,
      reason: rcon === "open" ? "the RCON port accepts connections" : "the RCON port did not refuse a connection",
    };
  }
  if (!consoleLog || typeof consoleLog.text !== "string" || !Number.isFinite(consoleLog.mtimeMs)) {
    return { stopped: false, reason: "the RCON port refuses connections, but the game's console log could not be read" };
  }
  const quietMs = now - consoleLog.mtimeMs;
  const prefix = "the RCON port refuses connections and the game's console log";
  if (consoleLog.text.includes(SHUTDOWN_FINISHED_LINE) && quietMs >= QUIET_AFTER_FINISHED_MS) {
    return { stopped: true, reason: `${prefix} ends with "${SHUTDOWN_FINISHED_LINE}"` };
  }
  if (SHUTDOWN_STARTED_RE.test(consoleLog.text) && quietMs >= QUIET_AFTER_SHUTDOWN_STARTED_MS) {
    return { stopped: true, reason: `${prefix} shows the shutdown and has been quiet for ${seconds(quietMs)} s` };
  }
  return { stopped: false, reason: "the RCON port refuses connections, but the game's console log does not show the server stopped" };
}

/** probeTcpPort() + readConsoleTail() + evaluateStoppedEvidence(). */
export async function readStoppedEvidence({
  rconHost,
  rconPort,
  consoleLogPath,
  now = () => Date.now(),
  probe = probeTcpPort,
  readTail = readConsoleTail,
}) {
  const host = !rconHost || rconHost === "0.0.0.0" || rconHost === "::" ? "127.0.0.1" : rconHost;
  const rcon = await probe(host, Number(rconPort));
  const consoleLog = rcon === "refused" ? readTail(consoleLogPath) : null;
  return evaluateStoppedEvidence({ rcon, consoleLog, now: now() });
}
