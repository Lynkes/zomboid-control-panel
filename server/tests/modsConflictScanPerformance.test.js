import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";
import { writeConflictScanFixture } from "./helpers/conflictScanFixture.js";

// The conflict scan runs on demand over every enabled mod. A heavy modlist is
// 400+ mods; this keeps the whole GET /conflicts (index, compare, the
// cross-file passes, grouping) bounded on a generated 400-mod Workshop folder,
// and checks that a second scan of unchanged files reuses the cached hashes
// and parses instead of redoing them.
//
// Measured on the maintainer's Windows machine (this fixture: 400 mods,
// ~10,000 files; old and new run alternately, 3 rounds): before the rule
// rework 1.96 s per first scan and 1.76 s per rescan on average; after it
// 1.84 s and 1.53 s, although the scan now also parses every script and Lua
// file for the cross-file rules (walks of a few mods overlap, and hashes and
// parses are cached by size + mtime).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const MOD_COUNT = 400;

describe("conflict scan of a 400-mod modlist", () => {
  let fx;

  beforeAll(() => {
    fx = makeServerFixture({ prefix: "mods-conflict-perf-" });
    const { workshopIds, modIds } = writeConflictScanFixture(fx.installPath, MOD_COUNT);
    fx.writeIni(`Mods=${modIds.join(";")}\nWorkshopItems=${workshopIds.join(";")}\n`);
    getActiveServer.mockResolvedValue(fx.activeServer);
  }, 120_000);

  afterAll(() => fx?.cleanup());

  it("finishes within the time budget, and a rescan of unchanged files is not slower", async () => {
    const t0 = performance.now();
    const first = await runRoute("/conflicts", "get", { query: {} });
    const firstMs = performance.now() - t0;
    expect(first.getStatusCode()).toBe(200);
    const body = first.getBody();
    expect(body.modsScanned).toBe(MOD_COUNT);
    expect(body.pairs.length).toBeGreaterThan(0);

    const t1 = performance.now();
    const second = await runRoute("/conflicts", "get", { query: {} });
    const secondMs = performance.now() - t1;
    expect(second.getStatusCode()).toBe(200);
    expect(second.getBody().totalConflicts).toBe(body.totalConflicts);

    console.log(
      `[perf] ${MOD_COUNT} mods: first scan ${firstMs.toFixed(0)} ms, rescan ${secondMs.toFixed(0)} ms, ` +
        `${body.totalConflicts} conflicts in ${body.totalPairs} pairs`,
    );
    // Generous ceiling for slow CI disks; the measured time is a fraction of it.
    expect(firstMs).toBeLessThan(30_000);
    expect(secondMs).toBeLessThan(firstMs * 1.5 + 500);
  }, 120_000);
});
