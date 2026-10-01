import { afterEach, describe, expect, it, vi } from "vitest";

// 2026-10-01 incident (42.21, Unraid): the game's main thread died during a
// world save (UnsatisfiedLinkError) while the process stayed up, RCON kept
// dropping, and every panel action that saves first ended at a dead end --
// "Save failed, so the server was left running" with no way forward. The
// refusals now name the next step (Force stop) and what it costs, and the
// panel still never force-stops on its own.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

const { runManagedLifecycleMock } = vi.hoisted(() => ({
  runManagedLifecycleMock: vi.fn(async () => ({ handled: false })),
}));
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycleMock(...args),
}));

const { default: router } = await import("../routes/server.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeApp(values) {
  return { get: (key) => values[key] };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("POST /stop: a failed pre-stop save points at Force stop", () => {
  it("names Force stop and its cost, carries the reason as a param, and stops nothing", async () => {
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: false, error: "RCON connection closed" }),
      quit: vi.fn(),
    };
    const serverManager = { stopServer: vi.fn(), markServerStopped: vi.fn() };
    const response = createResponse();

    await getHandler("/stop", "post")(
      { app: makeApp({ rconService, serverManager }), body: {} },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(502);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_STOP_SAVE_FAILED");
    expect(body.params).toEqual({ reason: "RCON connection closed" });
    expect(body.error).toContain("RCON connection closed");
    expect(body.error).toContain("Force stop");
    expect(body.error).toMatch(/since the last successful save can be lost/);
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.stopServer).not.toHaveBeenCalled();
  });

  it("names Force stop when RCON isn't connected at all", async () => {
    const rconService = { connected: false, save: vi.fn(), quit: vi.fn() };
    const response = createResponse();

    await getHandler("/stop", "post")({ app: makeApp({ rconService }), body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_STOP_RCON_NOT_CONNECTED");
    expect(body.error).toContain("Force stop");
    expect(rconService.save).not.toHaveBeenCalled();
  });
});

describe("POST /restart: a failed pre-restart save reaches the toast as a coded result", () => {
  it("forwards SERVER_RESTART_SAVE_FAILED and its path-free reason", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({
      success: false,
      wasRunning: true,
      logged: true,
      message: "Save failed; restart cancelled: RCON connection closed",
      code: "SERVER_RESTART_SAVE_FAILED",
      params: { reason: "write failed at /srv/pz/Zomboid/Saves" },
    });
    const response = createResponse();

    await getHandler("/restart", "post")(
      {
        app: makeApp({ scheduler: { performRestart, restartInProgress: false }, io: { emit } }),
        body: { warningMinutes: 0 },
      },
      response,
    );
    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "restart",
      success: false,
      message: "Save failed; restart cancelled: RCON connection closed",
      code: "SERVER_RESTART_SAVE_FAILED",
      params: { reason: "write failed at [path]" },
    });
  });

  it("adds nothing to an uncoded failure", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({
      success: false,
      message: "Could not confirm whether the server is stopped",
    });

    await getHandler("/restart", "post")(
      {
        app: makeApp({ scheduler: { performRestart, restartInProgress: false }, io: { emit } }),
        body: { warningMinutes: 0 },
      },
      createResponse(),
    );
    await flushMicrotasks();

    expect(emit).toHaveBeenCalledWith("scheduler:action_result", {
      kind: "restart",
      success: false,
      message: "Could not confirm whether the server is stopped",
    });
  });
});
