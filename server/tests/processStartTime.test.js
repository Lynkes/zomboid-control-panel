import { describe, expect, it, vi } from "vitest";
import {
  isPlausibleStartMs,
  parseElapsedTime,
  parseEpochMilliseconds,
  parseProcStatBootTime,
  parseProcStatStartTicks,
  readProcessStartTime,
} from "../utils/processStartTime.js";

// Server uptime is only as honest as the start time behind it. These pin
// each platform's way of asking the OS when a PID started -- Linux
// /proc/<pid>/stat + /proc/stat btime and the portable `ps -o etime=`
// fallback (Windows' arrives with the process scan's own Win32_Process row
// instead; see serverManagerWindowsProcessRow.test.js) -- plus the rule
// every one of them shares: anything short of a real answer is null ("unknown"),
// never 0 and never a guess. Everything is injected, so every platform's
// path runs on every CI host.

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const BOOT_SECONDS = Math.floor(Date.UTC(2026, 8, 20, 8, 0, 0) / 1000);

// A real /proc/<pid>/stat line, with a comm that contains both a space and
// a ")" -- the reason fields are split from after the LAST ")".
function procStatLine(pid, startTicks) {
  return `${pid} (java (main) x) S 1 ${pid} ${pid} 0 -1 4194560 91234 0 12 0 51234 8123 0 0 20 0 57 0 ${startTicks} 9876543210 1234567 18446744073709551615 1 1 0 0 0 0 0 4096 1260 0 0 0 17 3 0 0 0 0 0\n`;
}

function linuxReadFile(files) {
  return vi.fn(async (file) => {
    if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
    const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
    error.code = "ENOENT";
    throw error;
  });
}

function execFileAnswering(stdout, error = null) {
  return vi.fn((_file, _args, _options, callback) => {
    callback(error, stdout, "");
  });
}

describe("parseProcStatStartTicks", () => {
  it("reads field 22 even when the comm field contains spaces and parentheses", () => {
    expect(parseProcStatStartTicks(procStatLine(4242, 987654))).toBe(987654);
  });

  it("returns null for a truncated or unrecognised line", () => {
    expect(parseProcStatStartTicks("4242 (java) S 1 2 3")).toBeNull();
    expect(parseProcStatStartTicks("")).toBeNull();
  });
});

describe("parseProcStatBootTime", () => {
  it("reads the btime line", () => {
    expect(parseProcStatBootTime(`cpu  1 2 3\nbtime ${BOOT_SECONDS}\nprocesses 1\n`)).toBe(BOOT_SECONDS);
  });

  it("returns null when btime is missing", () => {
    expect(parseProcStatBootTime("cpu  1 2 3\n")).toBeNull();
  });
});

describe("parseElapsedTime", () => {
  it("reads every [[dd-]hh:]mm:ss shape ps prints", () => {
    expect(parseElapsedTime("   00:07\n")).toBe(7);
    expect(parseElapsedTime("05:06")).toBe(5 * 60 + 6);
    expect(parseElapsedTime("01:02:03")).toBe(3600 + 2 * 60 + 3);
    expect(parseElapsedTime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });

  it("returns null for anything else, including an empty answer", () => {
    expect(parseElapsedTime("")).toBeNull();
    expect(parseElapsedTime("ELAPSED")).toBeNull();
  });
});

describe("parseEpochMilliseconds", () => {
  it("reads a bare integer and rejects everything else", () => {
    expect(parseEpochMilliseconds("1790557595995\r\n")).toBe(1790557595995);
    expect(parseEpochMilliseconds("")).toBeNull();
    expect(parseEpochMilliseconds(undefined)).toBeNull();
    expect(parseEpochMilliseconds("27/09/2026 12:00:00")).toBeNull();
  });
});

describe("isPlausibleStartMs", () => {
  it("accepts a past epoch time, tolerating a minute of clock jitter, and nothing else", () => {
    expect(isPlausibleStartMs(NOW - 1000, NOW)).toBe(true);
    expect(isPlausibleStartMs(NOW + 30_000, NOW)).toBe(true);
    expect(isPlausibleStartMs(NOW + 3_600_000, NOW)).toBe(false);
    // Docker's "never started": 0001-01-01T00:00:00Z.
    expect(isPlausibleStartMs(Date.parse("0001-01-01T00:00:00Z"), NOW)).toBe(false);
    expect(isPlausibleStartMs(Number.NaN, NOW)).toBe(false);
  });
});

describe("readProcessStartTime", () => {
  it("never shells out or reads anything for a pid that isn't a plain positive integer", async () => {
    const execFile = vi.fn();
    const readFile = vi.fn();
    for (const pid of [undefined, null, "", "0", "12; rm -rf /", "-1", 3.5]) {
      await expect(
        readProcessStartTime(pid, { platform: "linux", execFile, readFile, now: () => NOW }),
      ).resolves.toBeNull();
    }
    expect(execFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  describe("on Linux", () => {
    it("derives the start time from /proc without spawning anything", async () => {
      const startTicks = 3 * 86400 * 100 + 12345; // 3 days + 123.45 s after boot
      const readFile = linuxReadFile({
        "/proc/stat": `cpu  1 2 3\nbtime ${BOOT_SECONDS}\n`,
        "/proc/4242/stat": procStatLine(4242, startTicks),
      });
      const execFile = vi.fn();

      const startedMs = await readProcessStartTime("4242", {
        platform: "linux", readFile, execFile, now: () => NOW,
      });

      expect(startedMs).toBe(BOOT_SECONDS * 1000 + startTicks * 10);
      expect(execFile).not.toHaveBeenCalled();
    });

    it("reports a pid with no /proc entry as unknown -- the process is gone, ps would not know better", async () => {
      const readFile = linuxReadFile({ "/proc/stat": `btime ${BOOT_SECONDS}\n` });
      const execFile = vi.fn();

      await expect(
        readProcessStartTime("4242", { platform: "linux", readFile, execFile, now: () => NOW }),
      ).resolves.toBeNull();
      expect(execFile).not.toHaveBeenCalled();
    });

    it("falls back to ps when /proc itself is unavailable", async () => {
      const readFile = linuxReadFile({});
      const execFile = execFileAnswering("  1-00:00:10\n");

      const startedMs = await readProcessStartTime("4242", {
        platform: "linux", readFile, execFile, now: () => NOW,
      });

      expect(startedMs).toBe(NOW - (86400 + 10) * 1000);
      expect(execFile).toHaveBeenCalledWith(
        "ps",
        ["-o", "etime=", "-p", "4242"],
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function),
      );
    });

    it("rejects an answer in the future as a parse or clock problem, not a start time", async () => {
      const readFile = linuxReadFile({
        "/proc/stat": `btime ${Math.floor(NOW / 1000) + 3600}\n`,
        "/proc/4242/stat": procStatLine(4242, 100),
      });

      await expect(
        readProcessStartTime("4242", { platform: "linux", readFile, execFile: vi.fn(), now: () => NOW }),
      ).resolves.toBeNull();
    });
  });

  describe("on macOS and other Unix", () => {
    it("asks ps for the elapsed time", async () => {
      const execFile = execFileAnswering("02:00:00\n");

      await expect(
        readProcessStartTime(777, { platform: "darwin", execFile, readFile: vi.fn(), now: () => NOW }),
      ).resolves.toBe(NOW - 2 * 3600 * 1000);
    });

    it("reports a failed or empty ps answer as unknown", async () => {
      await expect(
        readProcessStartTime("777", {
          platform: "darwin", execFile: execFileAnswering("", new Error("exit 1")), now: () => NOW,
        }),
      ).resolves.toBeNull();
      await expect(
        readProcessStartTime("777", { platform: "darwin", execFile: execFileAnswering(""), now: () => NOW }),
      ).resolves.toBeNull();
    });
  });

  describe("on Windows", () => {
    // A separate PowerShell lookup by PID was a second cold start per
    // process (often past its timeout while a loading PZ server saturated
    // the CPU) and, cached, could answer for a later process that reused
    // the PID. The scan's own Win32_Process row carries the start time.
    it("never spawns a lookup of its own", async () => {
      const execFile = vi.fn();
      const readFile = vi.fn();

      await expect(
        readProcessStartTime("9999", { platform: "win32", execFile, readFile, now: () => NOW }),
      ).resolves.toBeNull();
      expect(execFile).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    });
  });
});
