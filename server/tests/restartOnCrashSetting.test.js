import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  deleteServer,
  getSetting,
  logServerEvent,
  getServerEvents,
  setSetting,
} from "../database/init.js";

// restartOnCrashServerIds: the servers the server watch starts again when
// they go down without the panel asking (services/serverWatch.js), chosen per
// server on the Dashboard. Stored and refused like autoStartServerIds, and a
// deleted server leaves the list.

const { default: configRouter } = await import("../routes/config.js");

describe("PUT /api/config/app-settings: restartOnCrashServerIds", () => {
  const original = { ids: undefined };

  const handler = (() => {
    const layer = configRouter.stack.find(
      (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
  })();

  async function put(settings) {
    let statusCode = 200;
    let body = null;
    const res = {
      status(code) { statusCode = code; return res; },
      json(payload) { body = payload; return res; },
    };
    await handler({ body: { settings }, app: { get: () => undefined }, user: null }, res);
    return { statusCode, body };
  }

  afterEach(async () => {
    await setSetting("restartOnCrashServerIds", original.ids);
  });

  it("stores the ids as unique strings", async () => {
    original.ids = await getSetting("restartOnCrashServerIds");
    const { statusCode } = await put({ restartOnCrashServerIds: ["a", 7, "a", " b "] });

    expect(statusCode).toBe(200);
    expect(await getSetting("restartOnCrashServerIds")).toEqual(["a", "7", "b"]);
  });

  it.each([
    ["not a list", "s1"],
    ["a list holding something that isn't an id", ["s1", { id: "s2" }]],
    ["more ids than the bound", Array.from({ length: 101 }, (_, i) => `s${i}`)],
  ])("refuses %s with its own code", async (_label, value) => {
    original.ids = await getSetting("restartOnCrashServerIds");
    const { statusCode, body } = await put({ restartOnCrashServerIds: value });

    expect(statusCode).toBe(400);
    expect(body.code).toBe("CONFIG_RESTART_ON_CRASH_SERVER_IDS_INVALID");
    expect(body.error).toContain("restartOnCrashServerIds");
    expect(await getSetting("restartOnCrashServerIds")).toEqual(original.ids ?? null);
  });
});

describe("deleteServer() and the restart list", () => {
  afterEach(async () => {
    await setSetting("restartOnCrashServerIds", undefined);
  });

  it("takes a deleted server out of the servers to restart", async () => {
    const kept = await createServer({ name: "Kept", serverName: "RestartKept" });
    const removed = await createServer({ name: "Removed", serverName: "RestartRemoved" });
    try {
      await setSetting("restartOnCrashServerIds", [String(kept.id), String(removed.id)]);

      await deleteServer(removed.id);

      expect(await getSetting("restartOnCrashServerIds")).toEqual([String(kept.id)]);
    } finally {
      await deleteServer(kept.id).catch(() => {});
      await deleteServer(removed.id).catch(() => {});
    }
  });
});

describe("logServerEvent() for another server", () => {
  it("files the event under the server it names, not the active one", async () => {
    const entry = await logServerEvent("server_stop", "Second stopped", { serverId: "watch-other" });

    expect(entry.server_id).toBe("watch-other");
    const events = await getServerEvents(100, "watch-other");
    expect(events.some((event) => event.id === entry.id)).toBe(true);
  });
});
