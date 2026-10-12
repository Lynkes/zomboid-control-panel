import { describe, expect, it, vi } from "vitest";
import {
  parseProcStatusRssBytes,
  parsePsRssBytes,
  parseWindowsWorkingSetBytes,
  pidsFromProcessDetails,
  readProcessMemoryBytes,
  resolvePzMemoryBytes,
} from "../utils/pzProcessMemory.js";

// Console audit (2026-10-12): the dashboard's "PZ memory" came from the first
// Java process on the host whose command line mentioned
// zombie.network.GameServer -- another server's when two run side by side, and
// nothing at all for a remote server, which left the dashboard plotting the
// panel's own Node heap as "PZ memory". The process is now the one
// serverManager.getServerProcessDetails() attributes to the active server.

function details(overrides = {}) {
  return {
    running: true,
    scanFailed: false,
    matched: [{ pid: "4242", cmd: "java ... zombie.network.GameServer -servername A" }],
    owned: [{ pid: "4242", cmd: "java ... zombie.network.GameServer -servername A" }],
    ...overrides,
  };
}

describe("resolvePzMemoryBytes", () => {
  it("reads the memory of the process the server manager attributes to the active server", async () => {
    const serverManager = { getServerProcessDetails: vi.fn(async () => details()) };
    const readMemory = vi.fn(async () => 6_000_000_000);

    const bytes = await resolvePzMemoryBytes({
      activeServer: { id: "a", isRemote: false },
      serverManager,
      dockerClient: { enabled: false },
      readMemory,
    });

    expect(bytes).toBe(6_000_000_000);
    expect(readMemory).toHaveBeenCalledWith([4242]);
  });

  it("does not look at the host's processes at all for a remote server", async () => {
    const serverManager = { getServerProcessDetails: vi.fn(async () => details()) };
    const readMemory = vi.fn(async () => 1);

    const bytes = await resolvePzMemoryBytes({
      activeServer: { id: "r", isRemote: true },
      serverManager,
      dockerClient: { enabled: false },
      readMemory,
    });

    expect(bytes).toBeNull();
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
    expect(readMemory).not.toHaveBeenCalled();
  });

  it("has no reading when the active server is not running, or when the scan could not tell", async () => {
    const readMemory = vi.fn(async () => 1);
    for (const answer of [
      details({ running: false, matched: [], owned: [] }),
      details({ scanFailed: true }),
      null,
    ]) {
      const bytes = await resolvePzMemoryBytes({
        activeServer: { id: "a" },
        serverManager: { getServerProcessDetails: async () => answer },
        dockerClient: { enabled: false },
        readMemory,
      });
      expect(bytes).toBeNull();
    }
    expect(readMemory).not.toHaveBeenCalled();
  });

  it("has no reading when the process lookup throws", async () => {
    const bytes = await resolvePzMemoryBytes({
      activeServer: { id: "a" },
      serverManager: {
        getServerProcessDetails: async () => {
          throw new Error("scan exploded");
        },
      },
      dockerClient: { enabled: false },
      readMemory: vi.fn(),
    });
    expect(bytes).toBeNull();
  });

  it("keeps the Docker path: a managed container's own memory comes first", async () => {
    const serverManager = { getServerProcessDetails: vi.fn() };
    const dockerClient = {
      enabled: true,
      getContainerStats: vi.fn(async () => ({ memoryUsed: 5_700_000_000 })),
    };

    const bytes = await resolvePzMemoryBytes({
      activeServer: { id: "d", dockerContainerName: "pz" },
      serverManager,
      dockerClient,
      readMemory: vi.fn(),
    });

    expect(bytes).toBe(5_700_000_000);
    expect(dockerClient.getContainerStats).toHaveBeenCalledWith("pz");
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });

  it("plots the container's anonymous memory, not its page cache", async () => {
    const dockerClient = {
      enabled: true,
      getContainerStats: vi.fn(async () => ({
        memoryUsed: 5_700_000_000,
        memoryAnon: 1_500_000_000,
      })),
    };

    const bytes = await resolvePzMemoryBytes({
      activeServer: { id: "d", dockerContainerName: "pz" },
      serverManager: { getServerProcessDetails: vi.fn() },
      dockerClient,
      readMemory: vi.fn(),
    });

    expect(bytes).toBe(1_500_000_000);
  });

  it("falls back to the process when the container's stats are unavailable (a stopped container)", async () => {
    const dockerClient = {
      enabled: true,
      getContainerStats: vi.fn(async () => {
        throw new Error("not running");
      }),
    };
    const readMemory = vi.fn(async () => 123);

    const bytes = await resolvePzMemoryBytes({
      activeServer: { id: "d", dockerContainerName: "pz" },
      serverManager: { getServerProcessDetails: async () => details() },
      dockerClient,
      readMemory,
    });

    expect(bytes).toBe(123);
  });
});

describe("pidsFromProcessDetails", () => {
  it("prefers the processes the ownership check kept over the raw matches", () => {
    expect(
      pidsFromProcessDetails(
        details({ owned: [{ pid: 11 }], matched: [{ pid: "11" }, { pid: "22" }] }),
      ),
    ).toEqual([11]);
  });

  it("uses the service manager's main pid for a service-managed server", () => {
    expect(
      pidsFromProcessDetails({ running: true, matched: [], owned: [], mainPid: 777 }),
    ).toEqual([777]);
  });

  it("drops anything that is not a positive integer pid", () => {
    expect(
      pidsFromProcessDetails(details({ owned: [{ pid: "abc" }, { pid: "0" }, { pid: "-4" }, { pid: "9" }] })),
    ).toEqual([9]);
  });
});

describe("parsers", () => {
  it("reads VmRSS from /proc/<pid>/status in bytes", () => {
    expect(parseProcStatusRssBytes("Name:\tjava\nVmRSS:\t  2048 kB\nThreads:\t40\n")).toBe(2048 * 1024);
    expect(parseProcStatusRssBytes("Name:\tjava\n")).toBeNull();
  });

  it("takes the largest rss that ps printed", () => {
    expect(parsePsRssBytes("  1200\n 5000000\n")).toBe(5000000 * 1024);
    expect(parsePsRssBytes("")).toBeNull();
  });

  it("reads the bare byte count PowerShell prints", () => {
    expect(parseWindowsWorkingSetBytes("6123987968\r\n")).toBe(6123987968);
    expect(parseWindowsWorkingSetBytes("")).toBeNull();
  });
});

describe("readProcessMemoryBytes", () => {
  it("asks PowerShell for the working set of exactly the given pids on Windows", async () => {
    const execFile = vi.fn((file, args, options, callback) => callback(null, "4096000000\r\n"));

    const bytes = await readProcessMemoryBytes([4242], { platform: "win32", execFile });

    expect(bytes).toBe(4096000000);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe("powershell");
    expect(args.join(" ")).toMatch(/Get-Process -Id 4242\b/);
  });

  it("reads /proc/<pid>/status on Linux, no process spawn", async () => {
    const execFile = vi.fn();
    const readFile = vi.fn(async () => "VmRSS:\t 1000 kB\n");

    const bytes = await readProcessMemoryBytes([31], { platform: "linux", execFile, readFile });

    expect(bytes).toBe(1000 * 1024);
    expect(readFile).toHaveBeenCalledWith("/proc/31/status", "utf8");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to ps when /proc cannot be read", async () => {
    const execFile = vi.fn((file, args, options, callback) => callback(null, " 2000\n"));
    const readFile = vi.fn(async () => {
      throw new Error("ENOENT");
    });

    const bytes = await readProcessMemoryBytes([31], { platform: "linux", execFile, readFile });

    expect(bytes).toBe(2000 * 1024);
    expect(execFile.mock.calls[0][0]).toBe("ps");
    expect(execFile.mock.calls[0][1]).toEqual(["-o", "rss=", "-p", "31"]);
  });

  it("is null for no pids, and when the lookup fails", async () => {
    expect(await readProcessMemoryBytes([])).toBeNull();
    const execFile = vi.fn((file, args, options, callback) => callback(new Error("boom")));
    expect(await readProcessMemoryBytes([5], { platform: "darwin", execFile })).toBeNull();
  });
});
