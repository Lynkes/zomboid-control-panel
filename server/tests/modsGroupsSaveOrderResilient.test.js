import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Mod groups are an aid on top of the load order: POST /save-order puts a
// group's order into the list it writes, but a panel database that cannot be
// read for the groups must never stop the admin's own order from being saved.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getModGroups: vi.fn(),
}));

const { getActiveServer, getModGroups } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

describe("POST /save-order when the groups cannot be read", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-groups-resilient-", ini: "Mods=Alpha;Beta\n" });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getModGroups.mockReset().mockRejectedValue(new Error("db unavailable"));
  });

  afterEach(() => {
    fx.cleanup();
  });

  it("saves the client's order as it is and reports nothing adjusted", async () => {
    const res = await runRoute("/save-order", "post", { body: { modIds: ["Beta", "Alpha"] } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ modCount: 2, groupsAdjusted: [], groupConflicts: [] });
    expect(getModGroups).toHaveBeenCalled();
    expect(fx.iniValue("Mods")).toBe("Beta;Alpha");
  });
});
