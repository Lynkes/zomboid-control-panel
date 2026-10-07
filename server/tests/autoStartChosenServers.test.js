import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  deleteServer,
  getSetting,
  setSetting,
} from "../database/init.js";
import { autoStartOtherServers, selectAutoStartServers } from "../index.js";

// The boot auto-start used to start the active server alone: with several
// servers (the all-in-one container's, or native ones with their own
// folders), every panel restart left all but one stopped. autoStartServer is
// now the switch, autoStartServerIds names the servers, and a setting saved
// before that has no list and keeps starting the active server.

const { default: configRouter } = await import("../routes/config.js");

describe("selectAutoStartServers()", () => {
  const one = { id: "s1", name: "One" };
  const two = { id: "s2", name: "Two" };
  const three = { id: "s3", name: "Three" };
  const servers = [one, two, three];

  it("starts nothing while the switch is off, whatever the list says", () => {
    expect(
      selectAutoStartServers({ enabled: false, serverIds: ["s1", "s2"], servers, activeServer: one }),
    ).toEqual({ active: false, others: [] });
    expect(
      selectAutoStartServers({ enabled: null, serverIds: undefined, servers, activeServer: one }),
    ).toEqual({ active: false, others: [] });
  });

  it("starts the active server alone for a setting saved before servers could be chosen", () => {
    expect(
      selectAutoStartServers({ enabled: true, serverIds: null, servers, activeServer: two }),
    ).toEqual({ active: true, others: [] });
    // The same for the string form an old settings file may still hold.
    expect(
      selectAutoStartServers({ enabled: "true", serverIds: undefined, servers, activeServer: two }),
    ).toEqual({ active: true, others: [] });
  });

  it("starts the chosen servers, the active one through its own path and the rest in My Servers order", () => {
    expect(
      selectAutoStartServers({ enabled: true, serverIds: ["s3", "s1", "s2"], servers, activeServer: two }),
    ).toEqual({ active: true, others: [one, three] });
  });

  it("leaves the active server stopped when it isn't chosen", () => {
    expect(
      selectAutoStartServers({ enabled: true, serverIds: ["s3"], servers, activeServer: one }),
    ).toEqual({ active: false, others: [three] });
  });

  it("starts nothing for an empty list, and skips an id no server has", () => {
    expect(
      selectAutoStartServers({ enabled: true, serverIds: [], servers, activeServer: one }),
    ).toEqual({ active: false, others: [] });
    expect(
      selectAutoStartServers({ enabled: true, serverIds: ["gone", "s2"], servers, activeServer: one }),
    ).toEqual({ active: false, others: [two] });
  });

  it("matches a numeric id against its string form", () => {
    const numbered = { id: 7, name: "Seven" };
    expect(
      selectAutoStartServers({ enabled: true, serverIds: ["7"], servers: [numbered], activeServer: null }),
    ).toEqual({ active: false, others: [numbered] });
  });
});

describe("autoStartOtherServers()", () => {
  function deps({ processState = { running: false, scanFailed: false }, startResult = { success: true }, lock = true } = {}) {
    const release = vi.fn();
    const manager = { getServerProcessDetails: vi.fn(async () => processState) };
    return {
      manager,
      release,
      createManager: vi.fn(async () => manager),
      start: vi.fn(async () => startResult),
      acquireLock: vi.fn(() => (lock ? { release } : null)),
    };
  }

  it("starts each server through a manager of its own and the boot auto-start's launch, one lock at a time", async () => {
    const d = deps();
    const servers = [{ id: "s2", name: "Two" }, { id: "s3", name: "Three" }];

    const results = await autoStartOtherServers(servers, d);

    expect(results).toEqual([
      { serverId: "s2", outcome: "started" },
      { serverId: "s3", outcome: "started" },
    ]);
    expect(d.createManager.mock.calls).toEqual([["s2"], ["s3"]]);
    expect(d.acquireLock.mock.calls).toEqual([
      ["startup-auto-start", "s2"],
      ["startup-auto-start", "s3"],
    ]);
    expect(d.start).toHaveBeenNthCalledWith(1, servers[0], { serverManagerInstance: d.manager });
    expect(d.start).toHaveBeenNthCalledWith(2, servers[1], { serverManagerInstance: d.manager });
    expect(d.release).toHaveBeenCalledTimes(2);
  });

  it("leaves a running server alone, and one the scan can't answer for", async () => {
    const running = deps({ processState: { running: true, scanFailed: false } });
    expect(await autoStartOtherServers([{ id: "s2" }], running)).toEqual([
      { serverId: "s2", outcome: "alreadyRunning" },
    ]);
    expect(running.start).not.toHaveBeenCalled();

    const unknown = deps({ processState: { running: false, scanFailed: true } });
    expect(await autoStartOtherServers([{ id: "s2" }], unknown)).toEqual([
      { serverId: "s2", outcome: "unknown" },
    ]);
    expect(unknown.start).not.toHaveBeenCalled();
    expect(unknown.acquireLock).not.toHaveBeenCalled();
  });

  it("never launches a remote server", async () => {
    const d = deps();
    expect(await autoStartOtherServers([{ id: "s2", isRemote: true }], d)).toEqual([
      { serverId: "s2", outcome: "remote" },
    ]);
    expect(d.createManager).not.toHaveBeenCalled();
  });

  it("skips a server while another lifecycle operation holds the lock", async () => {
    const d = deps({ lock: false });
    expect(await autoStartOtherServers([{ id: "s2" }], d)).toEqual([
      { serverId: "s2", outcome: "busy" },
    ]);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("goes on to the next server after one fails, and releases the lock either way", async () => {
    const d = deps();
    d.start
      .mockResolvedValueOnce({ success: false, error: "game port 16261 is in use" })
      .mockRejectedValueOnce(new Error("Server path not configured"))
      .mockResolvedValueOnce({ success: true, alreadyRunning: true });

    const results = await autoStartOtherServers([{ id: "a" }, { id: "b" }, { id: "c" }], d);

    expect(results).toEqual([
      { serverId: "a", outcome: "failed" },
      { serverId: "b", outcome: "failed" },
      { serverId: "c", outcome: "alreadyRunning" },
    ]);
    expect(d.release).toHaveBeenCalledTimes(3);
  });
});

describe("PUT /api/config/app-settings: autoStartServerIds", () => {
  const original = { ids: undefined };

  function createResponse() {
    let statusCode = 200;
    let body = null;
    const response = {
      status(code) {
        statusCode = code;
        return response;
      },
      json(payload) {
        body = payload;
        return response;
      },
      getStatusCode: () => statusCode,
      getBody: () => body,
    };
    return response;
  }

  const handler = (() => {
    const layer = configRouter.stack.find(
      (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
  })();

  async function put(settings) {
    const response = createResponse();
    await handler({ body: { settings }, app: { get: () => undefined }, user: null }, response);
    return response;
  }

  afterEach(async () => {
    await setSetting("autoStartServerIds", original.ids);
  });

  it("stores the ids as unique strings", async () => {
    original.ids = await getSetting("autoStartServerIds");
    const response = await put({ autoStartServerIds: ["a", 7, "a", " b "] });

    expect(response.getStatusCode()).toBe(200);
    expect(await getSetting("autoStartServerIds")).toEqual(["a", "7", "b"]);
  });

  it.each([
    ["not a list", "s1"],
    ["a list holding something that isn't an id", ["s1", { id: "s2" }]],
    ["a list holding an empty id", [""]],
    ["more ids than the bound", Array.from({ length: 101 }, (_, i) => `s${i}`)],
  ])("refuses %s", async (_label, value) => {
    original.ids = await getSetting("autoStartServerIds");
    const response = await put({ autoStartServerIds: value });

    expect(response.getStatusCode()).toBe(400);
    expect(response.getBody().code).toBe("CONFIG_AUTO_START_SERVER_IDS_INVALID");
    expect(await getSetting("autoStartServerIds")).toEqual(original.ids ?? null);
  });
});

describe("deleteServer() and the auto-start list", () => {
  afterEach(async () => {
    await setSetting("autoStartServerIds", undefined);
  });

  it("takes a deleted server out of the servers to start", async () => {
    const kept = await createServer({ name: "Kept", serverName: "AutoStartKept" });
    const removed = await createServer({ name: "Removed", serverName: "AutoStartRemoved" });
    try {
      await setSetting("autoStartServerIds", [String(kept.id), String(removed.id)]);

      await deleteServer(removed.id);

      expect(await getSetting("autoStartServerIds")).toEqual([String(kept.id)]);
    } finally {
      await deleteServer(kept.id).catch(() => {});
      await deleteServer(removed.id).catch(() => {});
    }
  });
});
