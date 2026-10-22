import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stop and Force stop turn the server off even while a restart is running (a
// restart holds the one lifecycle lock for its whole run, so both were refused
// with "A 'restart' operation ... is already in progress"): they cancel the
// restart and take the lock when it frees -- or take it over when the restart
// is stuck in a step that cannot be interrupted. Any other holder still
// refuses them.

const activeServer = { value: { isRemote: false, id: "srv-1" } };
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => activeServer.value),
}));

vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn(),
}));

const { runManagedLifecycle } = await import("../services/managedContainer.js");
const { default: router, acquireLockForStop } = await import("../routes/server.js");
const {
  acquireLifecycleLock,
  getLifecycleLockHolder,
  isLifecycleLocked,
  supersedeLifecycleLock,
} = await import("../services/lifecycleCoordinator.js");

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

function makeApp(scheduler) {
  return {
    get: (key) => {
      if (key === "rconService") return { connected: false };
      if (key === "serverManager") return {};
      if (key === "io") return { emit: vi.fn() };
      if (key === "scheduler") return scheduler;
      return null;
    },
  };
}

let held;

beforeEach(() => {
  activeServer.value = { isRemote: false, id: "srv-1" };
  runManagedLifecycle.mockReset().mockResolvedValue({ handled: true, success: true, message: "Container stopped" });
});

afterEach(() => {
  held?.release();
  held = null;
  vi.useRealTimers();
});

describe("lifecycle lock: getLifecycleLockHolder / supersedeLifecycleLock", () => {
  it("names the holder, and a superseded holder can no longer free the new owner's lock", () => {
    expect(getLifecycleLockHolder()).toBeNull();
    held = acquireLifecycleLock("restart", "srv-1");
    expect(getLifecycleLockHolder()).toEqual({ operation: "restart", serverId: "srv-1" });

    const taken = supersedeLifecycleLock("force-stop", "srv-1");
    expect(getLifecycleLockHolder()).toEqual({ operation: "force-stop", serverId: "srv-1" });

    held.release(); // the old restart finishing later
    expect(isLifecycleLocked()).toBe(true);
    taken.release();
    expect(isLifecycleLocked()).toBe(false);
  });
});

describe("POST /force-stop while a restart runs", () => {
  it("cancels the restart and stops the server once the restart lets go", async () => {
    held = acquireLifecycleLock("restart", "srv-1");
    const scheduler = { cancelRestart: vi.fn(() => held.release()) };
    const response = createResponse();

    await getHandler("/force-stop", "post")({ app: makeApp(scheduler) }, response);

    expect(scheduler.cancelRestart).toHaveBeenCalledTimes(1);
    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: "srv-1" });
    expect(response.status).not.toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(isLifecycleLocked()).toBe(false);
  });

  it("takes the lock over when the restart is stuck and never lets go", async () => {
    vi.useFakeTimers();
    held = acquireLifecycleLock("restart", "srv-1");
    const scheduler = { cancelRestart: vi.fn() }; // the restart ignores the cancel
    const response = createResponse();

    const stopping = getHandler("/force-stop", "post")({ app: makeApp(scheduler) }, response);
    await vi.advanceTimersByTimeAsync(25000);
    await stopping;

    expect(runManagedLifecycle).toHaveBeenCalledWith("stop", { serverId: "srv-1" });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    // The stuck restart ending later does not free a lock it no longer owns.
    const next = acquireLifecycleLock("start", "srv-1");
    expect(next).not.toBeNull();
    held.release();
    expect(isLifecycleLocked()).toBe(true);
    next.release();
  });

  it("still refuses while something other than a restart holds the lock", async () => {
    held = acquireLifecycleLock("backup-restore", "srv-1");
    const scheduler = { cancelRestart: vi.fn() };
    const response = createResponse();

    await getHandler("/force-stop", "post")({ app: makeApp(scheduler) }, response);

    expect(scheduler.cancelRestart).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(409);
    expect(runManagedLifecycle).not.toHaveBeenCalled();
    expect(getLifecycleLockHolder()).toEqual({ operation: "backup-restore", serverId: "srv-1" });
  });

  it("does not touch another server's restart", async () => {
    held = acquireLifecycleLock("restart", "srv-2");
    const scheduler = { cancelRestart: vi.fn() };
    const response = createResponse();

    await getHandler("/force-stop", "post")({ app: makeApp(scheduler) }, response);

    expect(scheduler.cancelRestart).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(409);
  });
});

describe("acquireLockForStop() (used by POST /stop and POST /force-stop)", () => {
  it("returns the lock straight away when nothing runs", async () => {
    const lock = await acquireLockForStop("stop", "srv-1", makeApp({ cancelRestart: vi.fn() }));
    expect(lock).not.toBeNull();
    expect(getLifecycleLockHolder()).toEqual({ operation: "stop", serverId: "srv-1" });
    lock.release();
  });

  it("cancels a restart for a stop too, and returns the lock when it frees", async () => {
    held = acquireLifecycleLock("restart", "srv-1");
    const scheduler = { cancelRestart: vi.fn(() => held.release()) };

    const lock = await acquireLockForStop("stop", "srv-1", makeApp(scheduler));

    expect(scheduler.cancelRestart).toHaveBeenCalledTimes(1);
    expect(lock).not.toBeNull();
    expect(getLifecycleLockHolder()).toEqual({ operation: "stop", serverId: "srv-1" });
    lock.release();
  });

  it("treats a restart whose lock names no server as this server's", async () => {
    held = acquireLifecycleLock("restart", null);
    const scheduler = { cancelRestart: vi.fn(() => held.release()) };

    const lock = await acquireLockForStop("stop", "srv-1", makeApp(scheduler));

    expect(lock).not.toBeNull();
    lock.release();
  });
});
