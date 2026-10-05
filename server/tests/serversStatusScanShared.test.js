import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SDOS-4 (security sweep 2026-10-04): GET /api/servers/status has no
// capability gate, and every call ran its own host-wide process scan (a
// PowerShell Win32_Process query on Windows) -- plus the active server's own
// scan when the host scan couldn't place it. A burst of calls from any
// signed-in role started that many PowerShell processes at once (the
// verifier saw 24 alive together, ~1.7 GB). Calls now share one scan while
// it runs and reuse its answer for a moment after.

const getServers = vi.fn();
const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers,
  getActiveServer,
}));

const scanHostForServerProcesses = vi.fn();

vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

const { default: router } = await import("../routes/servers.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function statusHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/status" && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

// One app = one shared serverManager, as in index.js.
function fakeApp(serverManager = { isRunning: false }) {
  const services = { serverManager };
  return { get: (key) => services[key] };
}

async function burst(app, count) {
  const responses = Array.from({ length: count }, createResponse);
  await Promise.all(responses.map((res) => statusHandler()({ app }, res)));
  return responses.map((res) => res.json.mock.calls[0][0]);
}

const RUNNING_OTHER = {
  matched: [{ pid: "222", cmd: '"C:\\Servers\\Other\\java.exe" -cp pz.jar zombie.network.GameServer' }],
};

describe("GET /api/servers/status shares its host scan (SDOS-4)", () => {
  let now;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    getServers.mockReset().mockResolvedValue([
      { id: 1, name: "Active", installPath: "C:\\Servers\\Active" },
      { id: 2, name: "Other", installPath: "C:\\Servers\\Other" },
    ]);
    getActiveServer.mockReset().mockResolvedValue({ id: 1 });
    scanHostForServerProcesses.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs ONE scan for a burst of concurrent calls, and every call gets its answer", async () => {
    // Each scan stays running until released, so the burst overlaps it.
    const running = [];
    scanHostForServerProcesses.mockImplementation(
      () => new Promise((resolve) => { running.push(() => resolve(RUNNING_OTHER)); }),
    );
    const app = fakeApp({ isRunning: false, getServerProcessDetails: vi.fn().mockResolvedValue({ running: false }) });
    const pending = burst(app, 12);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of running) release();
    const payloads = await pending;

    expect(scanHostForServerProcesses).toHaveBeenCalledTimes(1);
    for (const payload of payloads) {
      expect(payload.servers.find((s) => s.id === 2)).toMatchObject({ running: true, pid: "222" });
    }
  });

  it("reuses a finished scan for a moment, then scans again", async () => {
    scanHostForServerProcesses.mockResolvedValue(RUNNING_OTHER);
    const app = fakeApp({ isRunning: false, getServerProcessDetails: vi.fn().mockResolvedValue({ running: false }) });

    await burst(app, 3);
    now += 1000;
    await burst(app, 3);
    expect(scanHostForServerProcesses).toHaveBeenCalledTimes(1);

    now += 5000;
    await burst(app, 3);
    expect(scanHostForServerProcesses).toHaveBeenCalledTimes(2);
  });

  it("shares the active server's own fallback scan the same way", async () => {
    // The host scan can't place the active server (stock launch, no args).
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    const getServerProcessDetails = vi.fn().mockResolvedValue({ running: true, scanFailed: false });
    const app = fakeApp({ isRunning: false, getServerProcessDetails });

    const payloads = await burst(app, 12);
    expect(getServerProcessDetails).toHaveBeenCalledTimes(1);
    for (const payload of payloads) {
      expect(payload.servers.find((s) => s.id === 1).running).toBe(true);
    }
  });

  it("doesn't reuse the fallback answer for a different active server", async () => {
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    const getServerProcessDetails = vi.fn().mockResolvedValue({ running: false, scanFailed: false });
    const app = fakeApp({ isRunning: false, getServerProcessDetails });

    await burst(app, 1);
    getActiveServer.mockResolvedValue({ id: 2 });
    await burst(app, 1);
    expect(getServerProcessDetails).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a scan that threw: the next call scans again", async () => {
    scanHostForServerProcesses
      .mockRejectedValueOnce(new Error("powershell exploded"))
      .mockResolvedValue(RUNNING_OTHER);
    const app = fakeApp({ isRunning: false, getServerProcessDetails: vi.fn().mockResolvedValue({ running: false }) });

    const [failed] = await burst(app, 1);
    expect(failed.detectionError).toBe("powershell exploded");
    const [ok] = await burst(app, 1);
    expect(ok.detectionError).toBeNull();
    expect(scanHostForServerProcesses).toHaveBeenCalledTimes(2);
  });
});
