import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLifecycleLock,
  getLifecycleLockHolder,
  getLifecycleState,
  holdServerUntilRcon,
  isLifecycleLocked,
  isLifecycleLockedForServer,
  lifecycleActivityCovers,
  lifecycleInProgressResponse,
  setLifecycleChangeListener,
  setServerDisplayNameResolver,
  supersedeLifecycleLock,
} from "../services/lifecycleCoordinator.js";

// A start held the one process-wide lifecycle lock until the server's RCON
// answered -- 1-3 minutes of a Project Zomboid boot -- so no other server
// could be started or stopped meanwhile. Once the process is up, the wait is
// now that server's own hold (holdServerUntilRcon): the other servers are
// free, this one and the operations for no server stay refused, and the
// refusal says why.

const held = [];
function track(lockOrHold) {
  if (lockOrHold) held.push(lockOrHold);
  return lockOrHold;
}

afterEach(() => {
  for (const item of held.splice(0)) item.release();
  setLifecycleChangeListener(null);
  setServerDisplayNameResolver(null);
});

describe("holdServerUntilRcon()", () => {
  it("frees the other servers while the started one waits for its RCON", () => {
    const start = track(acquireLifecycleLock("start", "alive"));
    expect(acquireLifecycleLock("start", "outbreak")).toBeNull();

    const hold = track(holdServerUntilRcon(start));
    expect(hold).not.toBeNull();

    const other = track(acquireLifecycleLock("stop", "outbreak"));
    expect(other).not.toBeNull();
    other.release();

    expect(acquireLifecycleLock("stop", "alive")).toBeNull();
    // An operation for no server in particular (boot auto-start, an update
    // with no server, /delete-files) waits for every server.
    expect(acquireLifecycleLock("delete-files")).toBeNull();

    hold.release();
    expect(track(acquireLifecycleLock("stop", "alive"))).not.toBeNull();
  });

  it("says the server is starting and waiting for RCON when it refuses", () => {
    setServerDisplayNameResolver((id) => (id === "alive" ? "LNKAlive" : null));
    track(holdServerUntilRcon(track(acquireLifecycleLock("start", "alive"))));

    expect(acquireLifecycleLock("restart", "alive")).toBeNull();
    const response = lifecycleInProgressResponse();
    expect(response.code).toBe("SERVER_LIFECYCLE_IN_PROGRESS");
    expect(response.error).toBe("'LNKAlive' is starting: the panel is waiting for its RCON to answer");
    expect(response.holder).toMatchObject({
      operation: "start",
      serverId: "alive",
      serverName: "LNKAlive",
      phase: "waiting-for-rcon",
    });
    expect(typeof response.holder.since).toBe("number");
  });

  it("names the process-wide lock's holder as before when that is what refuses", () => {
    setServerDisplayNameResolver((id) => (id === "outbreak" ? "LNK-OUTBREAK" : null));
    track(holdServerUntilRcon(track(acquireLifecycleLock("start", "alive"))));
    track(acquireLifecycleLock("stop", "outbreak"));

    expect(acquireLifecycleLock("start", "third")).toBeNull();
    const response = lifecycleInProgressResponse();
    expect(response.error).toBe("A 'stop' operation for 'LNK-OUTBREAK' is already in progress");
    expect(response.holder).toMatchObject({ operation: "stop", serverId: "outbreak", phase: null });
  });

  it("keeps switching the active server refused: the start may still poll the shared RCON connection", () => {
    track(holdServerUntilRcon(track(acquireLifecycleLock("start", "alive"))));

    expect(acquireLifecycleLock("server-profile-change", "outbreak", { panelWide: true })).toBeNull();
    // Editing another server's profile is that server's business only.
    expect(track(acquireLifecycleLock("server-profile-change", "outbreak"))).not.toBeNull();
  });

  it("hands nothing on from a lock a Stop already took over", () => {
    const restart = acquireLifecycleLock("restart", "alive");
    const stop = track(supersedeLifecycleLock("stop", "alive"));

    expect(holdServerUntilRcon(restart)).toBeNull();
    expect(getLifecycleLockHolder("alive")).toEqual({ operation: "stop", serverId: "alive" });
    stop.release();
    expect(getLifecycleLockHolder("alive")).toBeNull();
  });

  it("keeps a lock that names no server: there is nothing to narrow it to", () => {
    const lock = track(acquireLifecycleLock("startup-auto-start"));
    expect(holdServerUntilRcon(lock)).toBeNull();
    expect(acquireLifecycleLock("start", "outbreak")).toBeNull();
  });

  it("counts as that server's operation for the server watch and the same-server guards", () => {
    track(holdServerUntilRcon(track(acquireLifecycleLock("start", "alive"))));

    expect(isLifecycleLocked()).toBe(true);
    expect(isLifecycleLockedForServer("alive")).toBe(true);
    expect(isLifecycleLockedForServer("outbreak")).toBe(false);
    expect(lifecycleActivityCovers("alive", 0)).toBe(true);
    expect(getLifecycleLockHolder("alive")).toEqual({ operation: "start", serverId: "alive", phase: "waiting-for-rcon" });
    expect(getLifecycleLockHolder("outbreak")).toBeNull();
  });

  it("releases once: a second release of a hold that was taken over does nothing", () => {
    const hold = holdServerUntilRcon(acquireLifecycleLock("restart", "alive"));
    const stop = track(supersedeLifecycleLock("stop", "alive"));
    expect(stop).not.toBeNull();

    hold.release();
    expect(getLifecycleLockHolder("alive")).toMatchObject({ operation: "stop", serverId: "alive" });
  });
});

describe("supersedeLifecycleLock()", () => {
  it("never takes the process-wide lock from another server's operation", () => {
    track(holdServerUntilRcon(track(acquireLifecycleLock("restart", "alive"))));
    track(acquireLifecycleLock("start", "outbreak"));

    expect(supersedeLifecycleLock("stop", "alive")).toBeNull();
    expect(getLifecycleLockHolder("outbreak")).toMatchObject({ operation: "start", serverId: "outbreak" });
  });
});

describe("getLifecycleState() and the change listener", () => {
  it("lists the lock and every server's wait, and reports each change", () => {
    setServerDisplayNameResolver((id) => ({ alive: "LNKAlive", outbreak: "LNK-OUTBREAK" })[id] ?? null);
    const listener = vi.fn();
    setLifecycleChangeListener(listener);

    const start = track(acquireLifecycleLock("start", "alive"));
    expect(listener).toHaveBeenLastCalledWith({
      lock: expect.objectContaining({ operation: "start", serverId: "alive", serverName: "LNKAlive", phase: null }),
      servers: [],
    });

    const hold = track(holdServerUntilRcon(start));
    expect(listener).toHaveBeenLastCalledWith({
      lock: null,
      servers: [expect.objectContaining({ operation: "start", serverId: "alive", phase: "waiting-for-rcon" })],
    });

    const stop = track(acquireLifecycleLock("stop", "outbreak"));
    expect(getLifecycleState()).toEqual({
      lock: expect.objectContaining({ operation: "stop", serverName: "LNK-OUTBREAK" }),
      servers: [expect.objectContaining({ serverId: "alive" })],
    });

    stop.release();
    hold.release();
    expect(listener).toHaveBeenLastCalledWith({ lock: null, servers: [] });
  });
});
