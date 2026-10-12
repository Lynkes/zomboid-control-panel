import net from "net";
import { describe, expect, it, vi } from "vitest";
import {
  CONTAINER_SHUTDOWN_BUDGET_MS,
  isAllInOneContainer,
  saveAndQuitOverRcon,
  saveAndStopLocalServers,
} from "../services/containerShutdown.js";

// In the all-in-one image the game servers die with the container: docker
// stop SIGKILLs whatever is still running once the stop timeout is over. The
// panel therefore saves and quits them itself when it gets SIGTERM.

const instantSleep = () => Promise.resolve();

function makeDeps(overrides = {}) {
  const order = [];
  const rconService = {
    connected: true,
    stopAutoReconnect: vi.fn(),
    save: vi.fn(async () => {
      order.push("save");
      return { success: true };
    }),
    quit: vi.fn(async () => {
      order.push("quit");
      return { success: true };
    }),
  };
  // Running for the first scans after the quit, then gone.
  let scans = 0;
  const deps = {
    rconService,
    serverManager: {
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
    },
    getActiveServer: vi.fn(async () => ({
      id: "a",
      name: "Main",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "pw",
    })),
    findOtherRunningServers: vi.fn(async () => ({ scanFailed: false, servers: [], unattributed: [] })),
    scanHost: vi.fn(async () => {
      scans += 1;
      return { scanFailed: false, matched: scans <= 2 ? [{ pid: "10", cmd: "java" }] : [] };
    }),
    stopOverRcon: vi.fn(async () => ({ success: true })),
    sleep: instantSleep,
    pollIntervalMs: 1,
    budgetMs: 5000,
    ...overrides,
  };
  return { deps, rconService, order };
}

describe("isAllInOneContainer", () => {
  it("is on only inside the all-in-one image", () => {
    expect(isAllInOneContainer({ PANEL_ALL_IN_ONE: "true" })).toBe(true);
    expect(isAllInOneContainer({ PANEL_ALL_IN_ONE: "TRUE" })).toBe(true);
    expect(isAllInOneContainer({})).toBe(false);
    expect(isAllInOneContainer({ PANEL_ALL_IN_ONE: "false" })).toBe(false);
  });

  it("keeps the budget inside the compose stop_grace_period", () => {
    expect(CONTAINER_SHUTDOWN_BUDGET_MS).toBe(90 * 1000);
  });
});

describe("saveAndStopLocalServers", () => {
  it("saves, then quits, the active server over the panel's RCON and waits for it to exit", async () => {
    const { deps, rconService, order } = makeDeps();

    const outcome = await saveAndStopLocalServers(deps);

    expect(order).toEqual(["save", "quit"]);
    expect(deps.scanHost.mock.calls.length).toBeGreaterThan(2);
    expect(deps.stopOverRcon).not.toHaveBeenCalled();
    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(rconService.stopAutoReconnect).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ attempted: 1, stopped: true, timedOut: false });
  });

  it("still quits when the save fails, since quit saves too", async () => {
    const { deps, rconService, order } = makeDeps();
    rconService.save = vi.fn(async () => {
      order.push("save");
      return { success: false, error: "timed out" };
    });

    const outcome = await saveAndStopLocalServers(deps);

    expect(order).toEqual(["save", "quit"]);
    expect(outcome.stopped).toBe(true);
  });

  it("does nothing when no server is running", async () => {
    const { deps, rconService } = makeDeps();
    deps.serverManager.getServerProcessDetails = vi.fn(async () => ({ running: false, scanFailed: false }));

    const outcome = await saveAndStopLocalServers(deps);

    expect(rconService.save).not.toHaveBeenCalled();
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(deps.scanHost).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ attempted: 0, stopped: true });
  });

  it("uses an RCON connection of its own when the panel's is down", async () => {
    const { deps, rconService } = makeDeps();
    rconService.connected = false;

    await saveAndStopLocalServers(deps);

    expect(rconService.save).not.toHaveBeenCalled();
    expect(deps.stopOverRcon).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 27015,
      password: "pw",
    });
  });

  it("treats a failed process scan as running when RCON is connected", async () => {
    const { deps, rconService } = makeDeps();
    deps.serverManager.getServerProcessDetails = vi.fn(async () => ({ running: false, scanFailed: true }));

    await saveAndStopLocalServers(deps);

    expect(rconService.quit).toHaveBeenCalledTimes(1);
  });

  it("also saves and quits the other servers running in the container", async () => {
    const { deps, rconService } = makeDeps();
    deps.findOtherRunningServers = vi.fn(async () => ({
      scanFailed: false,
      servers: [
        { id: "b", name: "Second", rconHost: "127.0.0.1", rconPort: 27016, rconPassword: "pw2" },
        { id: "c", name: "Third", rconPort: 27017, rconPassword: "pw3" },
      ],
      unattributed: [],
    }));

    const outcome = await saveAndStopLocalServers(deps);

    expect(rconService.quit).toHaveBeenCalledTimes(1);
    expect(deps.stopOverRcon).toHaveBeenCalledTimes(2);
    expect(deps.stopOverRcon).toHaveBeenCalledWith({ host: "127.0.0.1", port: 27016, password: "pw2" });
    expect(deps.stopOverRcon).toHaveBeenCalledWith({ host: "127.0.0.1", port: 27017, password: "pw3" });
    expect(outcome.attempted).toBe(3);
  });

  it("gives up waiting after the budget and still returns", async () => {
    const { deps } = makeDeps({ budgetMs: 40, pollIntervalMs: 5, sleep: undefined });
    deps.scanHost = vi.fn(async () => ({ scanFailed: false, matched: [{ pid: "10", cmd: "java" }] }));

    const started = Date.now();
    const outcome = await saveAndStopLocalServers(deps);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome).toMatchObject({ stopped: false, timedOut: true });
  });

  it("is not held up by a save that never answers", async () => {
    const { deps, rconService } = makeDeps({ budgetMs: 60, pollIntervalMs: 5, sleep: undefined });
    rconService.save = vi.fn(() => new Promise(() => {}));
    deps.scanHost = vi.fn(async () => ({ scanFailed: false, matched: [{ pid: "10", cmd: "java" }] }));

    const started = Date.now();
    const outcome = await saveAndStopLocalServers(deps);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.timedOut).toBe(true);
  });

  it("never throws, whatever fails", async () => {
    const { deps } = makeDeps();
    deps.serverManager.getServerProcessDetails = vi.fn(async () => {
      throw new Error("boom");
    });
    deps.findOtherRunningServers = vi.fn(async () => {
      throw new Error("boom");
    });
    deps.getActiveServer = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(saveAndStopLocalServers(deps)).resolves.toMatchObject({ stopped: true });
  });
});

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body ?? "", "utf8");
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

// A fake game server: records the commands it gets, accepts one password,
// answers `save` and closes the connection on `quit` without a reply, as the
// real server does while it exits.
function startFakeRconServer({ password = "pw" } = {}) {
  const commands = [];
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 4) break;
          const total = 4 + buf.readInt32LE(0);
          if (buf.length < total) break;
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.toString("utf8", 12, total - 2);
          buf = buf.subarray(total);
          if (type === 3) {
            socket.write(encodePacket(id, 0, ""));
            socket.write(encodePacket(body === password ? id : -1, 2, ""));
          } else if (body === "quit") {
            commands.push(body);
            socket.destroy();
          } else {
            commands.push(body);
            socket.write(encodePacket(id, 0, "World saved"));
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, commands, port: server.address().port }));
  });
}

describe("saveAndQuitOverRcon", () => {
  it("sends save, then quit, and counts the dropped connection as the server exiting", async () => {
    const { server, commands, port } = await startFakeRconServer();
    try {
      const result = await saveAndQuitOverRcon({ host: "127.0.0.1", port, password: "pw" });
      expect(result).toEqual({ success: true });
      expect(commands).toEqual(["save", "quit"]);
    } finally {
      server.close();
    }
  });

  it("reports a wrong password without sending anything", async () => {
    const { server, commands, port } = await startFakeRconServer();
    try {
      const result = await saveAndQuitOverRcon({ host: "127.0.0.1", port, password: "nope" });
      expect(result.success).toBe(false);
      expect(commands).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("reports an unreachable server", async () => {
    const { server, port } = await startFakeRconServer();
    await new Promise((resolve) => server.close(resolve));
    const result = await saveAndQuitOverRcon({ host: "127.0.0.1", port, password: "pw", timeoutMs: 500 });
    expect(result.success).toBe(false);
  });
});
