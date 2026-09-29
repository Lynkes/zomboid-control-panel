import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Review of the Workshop-delivery merge: tryStartPanelBridge() awaited the
// boot reconcile (bounded to 15 s) BEFORE panelBridge.configure(). On a slow
// or network game folder that held the bridge path back past the status
// watchdog's first tick (+10 s), and that first stopped observation is the
// only one that pins a quietly stopped server's last heartbeat as dead
// (PanelBridge.markServerExited()): with no bridge path it pinned nothing
// and never retried. The bridge is now configured and started first, and
// the reconcile -- which never touches the bridge folder -- runs after it.

const order = vi.hoisted(() => []);
const dataDir = vi.hoisted(() => ({ path: null }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getActiveServer: vi.fn(async () => ({
      id: 1,
      name: "MAZE",
      serverName: "MAZE",
      isRemote: false,
      zomboidDataPath: dataDir.path,
    })),
    getAllSettings: vi.fn(async () => ({})),
  };
});

vi.mock("../services/bridgeDelivery.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    reconcileBridge: vi.fn(async () => {
      order.push("reconcile");
      return { method: "local", skipped: null, actions: [], warnings: [] };
    }),
  };
});

const { tryStartPanelBridge } = await import("../index.js");
const { default: panelBridge } = await import("../services/panelBridge.js");
const { reconcileBridge } = await import("../services/bridgeDelivery.js");

let configureSpy;

beforeEach(() => {
  order.length = 0;
  dataDir.path = fs.mkdtempSync(path.join(os.tmpdir(), "pb-boot-order-"));
  fs.mkdirSync(path.join(dataDir.path, "Lua", "panelbridge", "MAZE"), { recursive: true });
  panelBridge.isRunning = false;
  configureSpy = vi.spyOn(panelBridge, "configure").mockImplementation(() => {
    order.push("configure");
  });
  vi.spyOn(panelBridge, "start").mockImplementation(() => {
    order.push("start");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  panelBridge.isRunning = false;
  fs.rmSync(dataDir.path, { recursive: true, force: true });
});

describe("tryStartPanelBridge -- the bridge is watching before the boot reconcile runs", () => {
  it("configures and starts the bridge first, then awaits the reconcile", async () => {
    await expect(tryStartPanelBridge("startup")).resolves.toBe(true);
    expect(order).toEqual(["configure", "start", "reconcile"]);
    expect(configureSpy).toHaveBeenCalledWith(path.join(dataDir.path, "Lua", "panelbridge", "MAZE"), true);
    expect(reconcileBridge).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { reason: "boot" });
  });

  it("still reconciles when the bridge fails to start, and reports the failure", async () => {
    configureSpy.mockImplementation(() => {
      order.push("configure");
      throw new Error("bridge folder is not allowed");
    });
    await expect(tryStartPanelBridge("startup")).resolves.toBe(false);
    expect(order).toEqual(["configure", "reconcile"]);
  });
});
