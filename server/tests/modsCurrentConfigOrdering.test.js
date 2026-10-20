import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// GET /current-config (what the Mods page loads) carries, besides the old
// fields, every ordering field Build 42 reads from mod.info (loadModAfter=,
// loadModBefore=, incompatible=, read like the game does), the order the
// server really loads Mods= in, what is wrong with it, and the ordering rules
// a load-order sort should keep (utils/modLoadOrder.js).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

describe("GET /current-config ordering data", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({
      prefix: "mods-current-config-order-",
      ini: "Mods=Addon;Late;Core;Hater\nWorkshopItems=1000000001;1000000002;1000000003\n",
    });
    fx.writeMod("1000000001", "Lib", "name=Library\nid=Lib\n", "42");
    fx.writeMod("1000000001", "Core", "name=Core\nid=Core\nrequire=\\Lib\n", "42");
    fx.writeMod(
      "1000000002",
      "Addon",
      "name=Addon\nid=Addon\nrequire=\\Core\nloadModAfter=\\Late, \\Core\n",
      "common",
    );
    fx.writeMod("1000000002", "Late", "name=Late\nid=Late\nloadModBefore=\\Core\n", "42");
    fx.writeMod("1000000003", "Hater", "name=Hater\nid=Hater\nincompatible=\\Late\n", "42");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => fx.cleanup());

  it("adds the ordering fields to each mod, the effective order, warnings and constraints", async () => {
    const res = await runRoute("/current-config", "get", { query: {} });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();

    // Existing fields unchanged.
    expect(body.modIds).toEqual(["Addon", "Late", "Core", "Hater"]);
    const addon = body.workshopModMap["1000000002"].find((m) => m.id === "Addon");
    expect(addon).toEqual({
      id: "Addon",
      name: "Addon",
      enabled: true,
      require: ["Core"],
      loadAfter: ["Late", "Core"],
      // The game keeps the space: " Core" matches no mod in its mod selector.
      modInfoIssues: [{ field: "loadModAfter", entry: " Core", code: "whitespace" }],
    });
    expect(body.workshopModMap["1000000002"].find((m) => m.id === "Late").loadBefore).toEqual(["Core"]);
    expect(body.workshopModMap["1000000003"][0].incompatible).toEqual(["Late"]);

    // Lib is loaded although Mods= does not list it; Core before Addon.
    expect(body.effectiveModOrder).toEqual(["Lib", "Core", "Addon", "Late", "Hater"]);
    expect(body.orderWarnings).toEqual(
      expect.arrayContaining([
        { code: "requireAutoLoaded", severity: "info", modId: "Core", dependency: "Lib" },
        { code: "requireReordered", severity: "info", modId: "Addon", dependency: "Core" },
        { code: "loadAfterViolated", severity: "medium", modId: "Addon", other: "Late" },
        { code: "loadBeforeViolated", severity: "medium", modId: "Late", other: "Core" },
        { code: "declaredIncompatible", severity: "high", modId: "Late", other: "Hater" },
        { code: "modInfoListIssue", severity: "low", modId: "Addon", field: "loadModAfter", entry: " Core", issue: "whitespace" },
      ]),
    );
    expect(body.orderingConstraints).toEqual([
      { before: "Core", after: "Addon", reason: "require", reasons: ["require", "loadAfter"], declaredBy: "Addon" },
      { before: "Lib", after: "Core", reason: "require", declaredBy: "Core" },
      { before: "Late", after: "Addon", reason: "loadAfter", declaredBy: "Addon" },
      { before: "Late", after: "Core", reason: "loadBefore", declaredBy: "Late" },
    ]);
  });
});
