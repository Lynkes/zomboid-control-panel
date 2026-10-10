import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";
import { ErrorCode } from "../utils/errorCodes.js";

// POST /resolve-missing-deps took an unbounded `deps` array and, for every
// dep, re-read the mod.info of every downloaded workshop item synchronously
// (dozens of deps x hundreds of items = tens of thousands of blocking reads on
// the event loop). It now refuses more than 200 deps like its sibling
// /add-all-resolved-deps and reads each workshop item once per request.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

vi.mock("../services/workshopModInfo.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getModDetailsFromWorkshop: vi.fn(actual.getModDetailsFromWorkshop) };
});

const { getActiveServer } = await import("../database/init.js");
const { getModDetailsFromWorkshop } = await import("../services/workshopModInfo.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

describe("POST /resolve-missing-deps", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-resolve-deps-" });
    fx.writeMod("1111111111", "A", "name=Alpha Mod\nid=Alpha\n");
    fx.writeMod("2222222222", "B", "name=Beta Mod\nid=Beta\n");
    fx.writeMod("3333333333", "C", "name=Gamma Mod\nid=Gamma\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getModDetailsFromWorkshop.mockClear();
  });

  afterEach(() => fx.cleanup());

  it("refuses more than 200 deps with its own error code", async () => {
    const deps = Array.from({ length: 201 }, (_, i) => ({ missingDep: `Dep${i}` }));
    const res = await runRoute("/resolve-missing-deps", "post", { body: { deps } });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.MODS_RESOLVE_DEPS_TOO_MANY);
    expect(getModDetailsFromWorkshop).not.toHaveBeenCalled();
  });

  it("accepts exactly 200 deps", async () => {
    const deps = Array.from({ length: 200 }, (_, i) => ({ missingDep: `Dep${i}` }));
    const res = await runRoute("/resolve-missing-deps", "post", { body: { deps } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().deps).toHaveLength(200);
  });

  it("reads each downloaded workshop item once, however many deps there are", async () => {
    const deps = [];
    for (let i = 0; i < 60; i++) deps.push({ missingDep: i % 2 ? "Beta" : `Nope${i}` });
    const res = await runRoute("/resolve-missing-deps", "post", { body: { deps } });
    expect(res.getStatusCode()).toBe(200);
    // three downloaded items -> three reads (it was up to 3 x 60 before)
    expect(getModDetailsFromWorkshop.mock.calls.length).toBeLessThanOrEqual(3);
    expect(res.getBody().resolvedCount).toBe(30);
  });

  it("still resolves a dep to the workshop item that declares it, and leaves the rest alone", async () => {
    const res = await runRoute("/resolve-missing-deps", "post", {
      body: {
        deps: [
          { missingDep: "Gamma" },
          { missingDep: "Missing" },
          { missingDep: "Alpha", resolvedWorkshopId: "9" },
          { missingDep: 42 },
        ],
      },
    });
    expect(res.getBody().deps).toEqual([
      { missingDep: "Gamma", resolvedWorkshopId: "3333333333", resolvedModName: "Gamma Mod" },
      { missingDep: "Missing" },
      { missingDep: "Alpha", resolvedWorkshopId: "9" },
    ]);
    expect(res.getBody().resolvedCount).toBe(2);
  });
});
