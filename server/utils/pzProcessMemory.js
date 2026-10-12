import fs from "fs";
import { execFile as nodeExecFile } from "child_process";

// How much memory the ACTIVE server's game process uses -- the dashboard's
// "PZ memory".
//
// This used to take the first Java process whose command line mentioned
// zombie.network.GameServer, whichever server it belonged to. With two
// servers on one host that was the other one's whenever it came first; for a
// remote server it found nothing on this machine (or a local server's), and
// the dashboard then plotted the panel's own Node heap in its place. The
// process is resolved the way every other "is this server running" question
// is -- serverManager.getServerProcessDetails(), which holds a candidate to
// the server's own name and data folder -- and a server whose process the
// panel cannot see (remote, Docker without stats, stopped) has no reading: null.

const EXEC_TIMEOUT_MS = 5000;

// The process ids of the active server's game process(es), as positive
// integers, from getServerProcessDetails()'s answer. `owned` is what the
// ownership check kept; a service-managed Linux server has none of those but
// the service manager's own record (`mainPid`).
export function pidsFromProcessDetails(details) {
  if (!details || details.scanFailed || !details.running) return [];
  const candidates = [];
  for (const list of [details.owned, details.matched]) {
    if (!Array.isArray(list) || list.length === 0) continue;
    for (const entry of list) candidates.push(entry?.pid);
    break;
  }
  if (candidates.length === 0 && details.mainPid) candidates.push(details.mainPid);
  const pids = [];
  for (const raw of candidates) {
    const pid = Number(raw);
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids.slice(0, 3);
}

// "VmRSS:   123456 kB" from /proc/<pid>/status, in bytes.
export function parseProcStatusRssBytes(text) {
  const match = /^VmRSS:\s+(\d+)\s*kB\s*$/im.exec(String(text || ""));
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isSafeInteger(kb) && kb > 0 ? kb * 1024 : null;
}

// `ps -o rss= -p <pids>`: one resident size in KB per line. The largest, in
// bytes: a launcher script that is also a match is a few KB beside the JVM.
export function parsePsRssBytes(text) {
  let maxKb = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const kb = Number(line.trim());
    if (Number.isSafeInteger(kb) && kb > maxKb) maxKb = kb;
  }
  return maxKb > 0 ? maxKb * 1024 : null;
}

// The largest of Get-Process's WorkingSet64 values, as printed by
// Measure-Object (a bare number of bytes).
export function parseWindowsWorkingSetBytes(text) {
  const bytes = Number(String(text || "").trim());
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null;
}

function run(execFile, file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout || ""));
      });
    } catch {
      resolve(null);
    }
  });
}

// Resident memory in bytes of the largest of `pids`, or null when it cannot be
// read (the process is gone, the lookup failed or timed out). Never rejects.
export async function readProcessMemoryBytes(
  pids,
  { platform = process.platform, execFile = nodeExecFile, readFile = fs.promises.readFile } = {},
) {
  if (!Array.isArray(pids) || pids.length === 0) return null;
  const list = pids.join(",");

  if (platform === "win32") {
    const out = await run(execFile, "powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Process -Id ${list} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Maximum | Select-Object -ExpandProperty Maximum`,
    ]);
    return out === null ? null : parseWindowsWorkingSetBytes(out);
  }

  if (platform === "linux") {
    let best = null;
    for (const pid of pids) {
      try {
        const bytes = parseProcStatusRssBytes(await readFile(`/proc/${pid}/status`, "utf8"));
        if (bytes && (best === null || bytes > best)) best = bytes;
      } catch {
        /* gone, or /proc not readable: ps below */
      }
    }
    if (best !== null) return best;
  }

  const out = await run(execFile, "ps", ["-o", "rss=", "-p", list]);
  return out === null ? null : parsePsRssBytes(out);
}

// The active server's game memory in bytes, or null when there is no reading.
//  - a Docker-managed server: its container's memory, the number the Docker
//    page shows -- the JVM is in another PID namespace the panel cannot see;
//  - a remote server: null, whatever is running on this host is not it;
//  - otherwise the server's own process, resolved through `serverManager`.
export async function resolvePzMemoryBytes({
  activeServer,
  serverManager,
  dockerClient,
  readMemory = readProcessMemoryBytes,
}) {
  try {
    const containerRef = activeServer?.dockerContainerName || activeServer?.dockerContainerId;
    if (containerRef && dockerClient?.enabled) {
      const stats = await dockerClient.getContainerStats(containerRef);
      if (stats?.memoryUsed > 0) return stats.memoryUsed;
    }
  } catch {
    // fall through to the process lookup
  }

  if (activeServer?.isRemote) return null;
  if (typeof serverManager?.getServerProcessDetails !== "function") return null;

  let details;
  try {
    details = await serverManager.getServerProcessDetails();
  } catch {
    return null;
  }
  const pids = pidsFromProcessDetails(details);
  if (pids.length === 0) return null;
  return readMemory(pids);
}
