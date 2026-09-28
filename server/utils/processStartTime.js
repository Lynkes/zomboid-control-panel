import fs from "fs";
import path from "path";
import { execFile as nodeExecFile } from "child_process";

// When did process <pid> start -- asked of the operating system, never
// inferred from when the panel happened to launch or first notice it.
//
// Server uptime used to come from an in-memory timestamp the panel set when
// IT spawned the game server, with an OS lookup only as a one-off recovery
// when that timestamp was missing. Anything the panel didn't spawn in its
// current lifetime therefore depended on that recovery, and it only ran for
// a PID from the local process scan -- a systemd/OpenRC-managed server has
// none, so its uptime was simply never known after a panel restart or when
// the service manager started it at boot. Asking the OS for the tracked
// PID's real start time answers the same question the same way no matter
// who started the process or when the panel last restarted.
//
// Resolves to epoch milliseconds, or null when it can't be determined (the
// pid is gone, the lookup failed or timed out, or the platform has no way
// to ask). Callers must render null as "unknown", never as zero. Never
// rejects.

const EXEC_TIMEOUT_MS = 5000;

// USER_HZ, the unit /proc/<pid>/stat's starttime field is expressed in. It
// is part of the kernel's userspace ABI rather than the (configurable)
// internal HZ, and it is 100 on every architecture Node.js ships for (x64,
// arm, arm64, ppc64, s390x, riscv64, loong64 -- asm-generic/param.h); only
// alpha and ia64 ever differed. Hardcoded rather than shelling out to
// `getconf CLK_TCK`, which would turn a two-file read into a process spawn.
const LINUX_USER_HZ = 100;

// A start time before the Unix epoch, or meaningfully in the future, is a
// parse error or a clock problem -- not a real answer.
const MAX_FUTURE_SKEW_MS = 60_000;

function isPlausibleStartMs(value, nowMs) {
  return (
    Number.isFinite(value) && value > 0 && value <= nowMs + MAX_FUTURE_SKEW_MS
  );
}

// Field 22 (starttime, clock ticks after boot) of /proc/<pid>/stat. Field 2
// (comm) is parenthesised and may itself contain spaces or ")" -- a JVM
// names threads freely -- so the remaining fields are split from after the
// LAST ")", where fields[0] is field 3 (state) and field 22 is fields[19].
export function parseProcStatStartTicks(statText) {
  const text = String(statText || "");
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
}

// The "btime" line of /proc/stat: boot time, in seconds since the epoch.
export function parseProcStatBootTime(procStatText) {
  const match = /^btime\s+(\d+)\s*$/m.exec(String(procStatText || ""));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

// `ps -o etime=` output, "[[dd-]hh:]mm:ss", in seconds. etime rather than
// etimes because procps, BSD/macOS and busybox all print etime in this one
// format, while etimes (plain seconds) is procps-only.
export function parseElapsedTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(
    String(text || "").trim(),
  );
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 +
    Number(seconds)
  );
}

// The Windows query's own output: a bare integer (epoch milliseconds).
export function parseEpochMilliseconds(stdout) {
  const text = String(stdout || "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function runFile(execFile, file, args) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? null : String(stdout || "")),
      );
    } catch {
      resolve(null);
    }
  });
}

// Two small file reads, no process spawn. Resolves `undefined` (not null)
// when /proc itself is unavailable, so the caller can still fall back to
// ps; a /proc that is there but has no entry for this pid is a real answer
// (the process is gone), and resolves null.
async function readLinuxStartTime(pid, readFile) {
  let procStat;
  try {
    procStat = await readFile("/proc/stat", "utf8");
  } catch {
    return undefined;
  }
  const bootSeconds = parseProcStatBootTime(procStat);
  if (bootSeconds === null) return undefined;
  try {
    const ticks = parseProcStatStartTicks(
      await readFile(`/proc/${pid}/stat`, "utf8"),
    );
    if (ticks === null) return null;
    return bootSeconds * 1000 + Math.round((ticks * 1000) / LINUX_USER_HZ);
  } catch {
    return null;
  }
}

async function readElapsedViaPs(pid, execFile, now) {
  const stdout = await runFile(execFile, "ps", ["-o", "etime=", "-p", pid]);
  const elapsedSeconds = stdout === null ? null : parseElapsedTime(stdout);
  return elapsedSeconds === null ? null : now() - elapsedSeconds * 1000;
}

// Same Get-CimInstance Win32_Process convention as serverManager.js's own
// process scan, narrowed to one pid's CreationDate and converted to epoch
// milliseconds inside PowerShell, so nothing locale-formatted ever reaches
// this side. -ErrorAction Stop (a CIM failure) and an explicit exit for "no
// such process" both surface as a non-zero exit, i.e. null here -- never as
// an empty string that could be mistaken for an answer.
async function readWindowsStartTime(pid, execFile) {
  const powershellPath = path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; ` +
    "if (-not $p) { exit 3 }; " +
    "([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()";
  const stdout = await runFile(execFile, powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  return stdout === null ? null : parseEpochMilliseconds(stdout);
}

export async function readProcessStartTime(pid, options = {}) {
  const pidText = String(pid ?? "");
  // Digits only, and never 0 (systemd's MainPID for a unit with no running
  // process) -- this string is interpolated into the Windows query.
  if (!/^[1-9]\d*$/.test(pidText)) return null;

  const platform = options.platform || process.platform;
  const execFile = options.execFile || nodeExecFile;
  const readFile = options.readFile || fs.promises.readFile;
  const now = options.now || Date.now;

  try {
    let startMs;
    if (platform === "win32") {
      startMs = await readWindowsStartTime(pidText, execFile);
    } else {
      if (platform === "linux") {
        startMs = await readLinuxStartTime(pidText, readFile);
      }
      if (startMs === undefined) {
        startMs = await readElapsedViaPs(pidText, execFile, now);
      }
    }
    return isPlausibleStartMs(startMs, now()) ? startMs : null;
  } catch {
    return null;
  }
}
