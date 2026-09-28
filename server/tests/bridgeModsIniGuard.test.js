import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { UNPUBLISHED_WORKSHOP_RELEASE } from "./helpers/workshopRelease.js";
import {
  MOD,
  WS_ID,
  createRoot,
  createServerFiles,
  makeServer,
  readText,
} from "./helpers/bridgeDeliveryFixtures.js";

// With Steam Workshop delivery the bridge's Mods=/WorkshopItems= entries are
// managed in Settings › PanelBridge: the Mods page's remove, batch remove,
// toggle, load-order save and collection import (which lands through
// /write-to-ini) must not be able to drop them -- one missing entry and the
// server either starts without the bridge or refuses every join. mods.js's
// single ini writer puts them back at their old position; this drives the
// real routes against a real ini to prove it.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  // batch-remove also clears the removed items from the tracked-mods table.
  return { ...dbMockImplementation(dbState), getTrackedMods: async () => [], removeTrackedMod: async () => {} };
});

const { default: router } = await import("../routes/mods.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

let root;
let files;

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function post(routePath, body) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle({ body, user: { role: "admin" } }, res);
  expect(res.status).not.toHaveBeenCalledWith(500);
  return res;
}

function useServer(extra = {}) {
  dbState.servers = [makeServer(files, { serverConfigPath: `${files.dataDir}/Server`, ...extra })];
}

const WORKSHOP = {
  bridgeDelivery: "workshop",
  bridgeDeliverySwitch: { to: "workshop", at: "2026-01-01T00:00:00.000Z", by: null, bridgeStartedAt: null, workshopId: WS_ID },
};

beforeEach(() => {
  vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", UNPUBLISHED_WORKSHOP_RELEASE);
  _resetWorkshopReleaseCacheForTests();
  root = createRoot();
  files = createServerFiles(root, {
    ini: `PVP=true\r\nMods=First;${MOD};Last\r\nWorkshopItems=111;${WS_ID};222\r\nDoLuaChecksum=true\r\n`,
  });
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workshop delivery: the bridge entries survive the mod tools", () => {
  beforeEach(() => useServer(WORKSHOP));

  it("remove-from-ini of the bridge's own item keeps it at the same index", async () => {
    await post("/remove-from-ini", { workshopId: WS_ID, modId: MOD, modIds: [MOD] });
    expect(readText(files.iniPath)).toContain(`WorkshopItems=111;${WS_ID};222`);
    expect(readText(files.iniPath)).toContain(`Mods=First;${MOD};Last`);
  });

  it("batch-remove keeps the bridge item while removing the others", async () => {
    await post("/batch-remove", { workshopIds: ["111", WS_ID] });
    // Put back at min(old index, new length): index 1 in a one-entry list.
    expect(readText(files.iniPath)).toContain(`WorkshopItems=222;${WS_ID}`);
  });

  it("toggling the bridge mod off keeps it enabled", async () => {
    await post("/toggle-mod-id", { modId: MOD, enabled: false });
    expect(readText(files.iniPath)).toContain(`Mods=First;${MOD};Last`);
  });

  it("a load-order save that drops the bridge puts it back at its old index", async () => {
    await post("/save-order", { modIds: ["Last", "First"] });
    expect(readText(files.iniPath)).toContain(`Mods=Last;${MOD};First`);
  });

  it("a load-order save that moves the bridge keeps the new order", async () => {
    await post("/save-order", { modIds: [MOD, "Last", "First"] });
    expect(readText(files.iniPath)).toContain(`Mods=${MOD};Last;First`);
  });

  it("a collection import (write-to-ini replaces both lists) keeps both entries", async () => {
    await post("/write-to-ini", { mods: [{ workshopId: "333", modId: "Imported" }] });
    const ini = readText(files.iniPath);
    expect(ini).toMatch(new RegExp(`^Mods=.*\\b${MOD}\\b`, "m"));
    expect(ini).toMatch(new RegExp(`^WorkshopItems=.*\\b${WS_ID}\\b`, "m"));
    expect(ini).toContain("Imported");
    expect(ini).toContain("333");
  });

  it("GET /current-config marks the managed entries", async () => {
    const layer = router.stack.find((entry) => entry.route?.path === "/current-config" && entry.route.methods.get);
    const res = createResponse();
    await layer.route.stack[layer.route.stack.length - 1].handle({ query: {} }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ bridgeManaged: { modId: MOD, workshopId: WS_ID } }));
  });

  it("never adds an entry that wasn't there before", async () => {
    fs.writeFileSync(files.iniPath, "Mods=First\r\nWorkshopItems=111\r\n");
    await post("/save-order", { modIds: ["First"] });
    expect(readText(files.iniPath)).toBe("Mods=First\nWorkshopItems=111\n");
  });
});

describe("panel-installed delivery", () => {
  beforeEach(() => useServer());

  it("the guard is a no-op: removing the entries works as for any mod", async () => {
    await post("/save-order", { modIds: ["First", "Last"] });
    expect(readText(files.iniPath)).toContain("Mods=First;Last");
    await post("/batch-remove", { workshopIds: [WS_ID] });
    expect(readText(files.iniPath)).toContain("WorkshopItems=111;222");
  });

  it("GET /current-config reports no managed entries", async () => {
    const layer = router.stack.find((entry) => entry.route?.path === "/current-config" && entry.route.methods.get);
    const res = createResponse();
    await layer.route.stack[layer.route.stack.length - 1].handle({ query: {} }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ bridgeManaged: null }));
  });
});
