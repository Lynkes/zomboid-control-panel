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
const { getActiveServer } = await import("../database/init.js");

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

  // Review finding (2026-10-01): this refusal said Force stop "tries one
  // quick save" -- but Force stop skips the save while RCON is disconnected
  // (attemptBoundedSaveBeforeForceStop()), which is exactly this case.
  it("names Force stop when RCON isn't connected at all, without promising a save it can't make", async () => {
    const rconService = { connected: false, save: vi.fn(), quit: vi.fn() };
    const response = createResponse();

    await getHandler("/stop", "post")({ app: makeApp({ rconService }), body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_STOP_RCON_NOT_CONNECTED");
    expect(body.error).toContain("Force stop");
    expect(body.error).not.toMatch(/tries one quick save/);
    expect(body.error).toMatch(/while RCON is disconnected it can't save first/);
    expect(body.error).toMatch(/since the last successful save will be lost/);
    expect(rconService.save).not.toHaveBeenCalled();
  });
});

// Review finding (2026-10-01): a remote server has no Force stop (POST
// /force-stop refuses it and the Dashboard disables the button), yet a
// failed Stop pointed there.
describe("POST /stop on a remote server: the way out is its own host, not Force stop", () => {
  it("RCON not connected: its own code, no Force stop", async () => {
    vi.mocked(getActiveServer).mockResolvedValueOnce({ id: 9, isRemote: true });
    const rconService = { connected: false, save: vi.fn(), quit: vi.fn() };
    const response = createResponse();

    await getHandler("/stop", "post")({ app: makeApp({ rconService }), body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_STOP_RCON_NOT_CONNECTED_REMOTE");
    expect(body.error).not.toMatch(/use Force stop/);
    expect(body.error).toMatch(/restart it on the machine that hosts it/);
    expect(rconService.save).not.toHaveBeenCalled();
  });

  it("save failed: its own code and the reason, no Force stop", async () => {
    vi.mocked(getActiveServer).mockResolvedValueOnce({ id: 9, isRemote: true });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: false, error: "RCON connection closed" }),
      quit: vi.fn(),
    };
    const response = createResponse();

    await getHandler("/stop", "post")({ app: makeApp({ rconService }), body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(502);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_STOP_SAVE_FAILED_REMOTE");
    expect(body.params).toEqual({ reason: "RCON connection closed" });
    expect(body.error).not.toMatch(/use Force stop/);
    expect(body.error).toMatch(/restart it on the machine that hosts it/);
    expect(rconService.quit).not.toHaveBeenCalled();
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

  it("forwards SERVER_RESTART_RCON_UNAVAILABLE (a stuck server fails RCON's test command first)", async () => {
    const emit = vi.fn();
    const performRestart = vi.fn().mockResolvedValue({
      success: false,
      wasRunning: true,
      logged: true,
      message: "RCON not available: RCON connection closed",
      code: "SERVER_RESTART_RCON_UNAVAILABLE",
      params: { reason: "RCON connection closed" },
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
      message: "RCON not available: RCON connection closed",
      code: "SERVER_RESTART_RCON_UNAVAILABLE",
      params: { reason: "RCON connection closed" },
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
