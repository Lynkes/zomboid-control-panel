import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Security audit 2026-10-20: the map tile routes are auth-exempt (<img>
// tags), and a tile upstream answered 404 for (outside the map, a level the
// build doesn't render) was never remembered: every request for it was a
// fresh upstream fetch. A 404 is now remembered per tile for 10 minutes, in
// a bounded map; 5xx answers are not remembered.

vi.mock("../database/init.js", () => ({ getActiveServer: vi.fn() }));
vi.mock("../utils/vehiclesDb.js", () => ({ listPersistedVehicles: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function findRoute(router, routePath, method) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const res = { headers: {}, statusCode: 200 };
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.end = () => res;
  res.send = () => res;
  res.json = () => res;
  return res;
}

let mapProxy;
let originalFetch;

async function getTile(tile) {
  const res = makeRes();
  await findRoute(mapProxy.default, "/b41tiles/:level/:tile", "get")({ params: { level: "20", tile }, query: {} }, res);
  return res;
}

const fetchedTiles = () => global.fetch.mock.calls.map((call) => String(call[0]).split("/").pop());

beforeEach(async () => {
  vi.resetModules();
  mapProxy = await import("../routes/mapProxy.js");
  originalFetch = global.fetch;
  global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("map tile proxy: upstream 404s", () => {
  it("are answered from memory for a while instead of asking upstream again", async () => {
    const first = await getTile("900_900.jpg");
    expect(first.statusCode).toBe(404);
    expect(first.headers["X-Tile-Cache"]).toBe("miss");

    for (let i = 0; i < 5; i++) {
      const again = await getTile("900_900.jpg");
      expect(again.statusCode).toBe(404);
      expect(again.headers["X-Tile-Cache"]).toBe("hit-404");
    }
    expect(fetchedTiles()).toEqual(["900_900.jpg"]);

    await getTile("901_900.jpg");
    expect(fetchedTiles()).toEqual(["900_900.jpg", "901_900.jpg"]);
  });

  it("are asked about again once the entry expires", async () => {
    mapProxy._setTileNotFoundLimitsForTests({ ttlMs: 20 });
    await getTile("900_900.jpg");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const again = await getTile("900_900.jpg");
    expect(again.headers["X-Tile-Cache"]).toBe("miss");
    expect(fetchedTiles()).toEqual(["900_900.jpg", "900_900.jpg"]);
  });

  it("are kept in a bounded map, the oldest dropped first", async () => {
    mapProxy._setTileNotFoundLimitsForTests({ maxEntries: 3 });
    for (const tile of ["1_1.jpg", "2_2.jpg", "3_3.jpg", "4_4.jpg"]) await getTile(tile);
    expect((await getTile("4_4.jpg")).headers["X-Tile-Cache"]).toBe("hit-404");
    expect((await getTile("1_1.jpg")).headers["X-Tile-Cache"]).toBe("miss");
  });

  it("a 5xx is not remembered", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    expect((await getTile("7_7.jpg")).statusCode).toBe(502);
    expect((await getTile("7_7.jpg")).statusCode).toBe(502);
    // One retry each, both times.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});
