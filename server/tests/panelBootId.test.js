import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A page waiting for the panel to restart used to judge "it's back" by any
// /api/health answer, or by the version after an update. Neither tells the
// old process (still answering while the all-in-one container saves and
// stops its game servers) from the new one, and a Start.bat rollback comes
// back on the OLD version, so the update wait never ended. Each process now
// has its own bootId, and the restart request answers with the one going
// away.

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { vi: vitest } = await import("vitest");
  const { EventEmitter } = await import("events");
  const spawn = vitest.fn(() => Object.assign(new EventEmitter(), { unref: () => {} }));
  return { ...actual, default: { ...actual, spawn }, spawn };
});

vi.mock("../services/panelBridge.js", async () => {
  const { EventEmitter } = await import("events");
  const { vi: vitest } = await import("vitest");
  const fake = new EventEmitter();
  fake.isRunning = false;
  fake.stop = vitest.fn();
  return { default: fake };
});

const { app } = await import("../index.js");

function routeHandler(path, method) {
  const layer = app.router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function health() {
  const res = makeRes();
  routeHandler("/api/health", "get")({}, res);
  return res.json.mock.calls[0][0];
}

let originalPkg;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  originalPkg = process.pkg;
  process.pkg = undefined;
  vi.spyOn(process, "exit").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  process.pkg = originalPkg;
  vi.restoreAllMocks();
});

describe("panel bootId", () => {
  it("is reported by /api/health and stays the same for the life of the process", () => {
    const first = health();
    const second = health();
    expect(typeof first.bootId).toBe("string");
    expect(first.bootId.length).toBeGreaterThanOrEqual(16);
    expect(second.bootId).toBe(first.bootId);
  });

  it("is returned by POST /api/panel/restart, so the page knows which process is going away", async () => {
    const { bootId } = health();
    const res = makeRes();
    await routeHandler("/api/panel/restart", "post")(
      { app: { get: (key) => (key === "panelUpdateChecker" ? { isApplying: false, getStagedUpdate: () => null } : undefined) } },
      res,
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, bootId }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());
  });
});
