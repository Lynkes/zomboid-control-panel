import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// worker-pz-worldmap bug hunt (2026-09-18): /tiles' floor query bound
// (parseBoundedInteger(..., -17, 29)) claims to mirror WorldMap.tsx's
// changeFloor clamp ("Client clamps floor to -17..29 (WorldMap.tsx
// changeFloor); keep the backend in sync") but changeFloor actually clamps
// to Math.max(-1, Math.min(7, newFloor)) -- the real, only-ever-published
// B42 layer range per WorldMap.tsx's own "Published B42 map layers: -1 =
// basement, 0 = ground, 1-7 = upper floors" comment. The backend accepting
// -17..29 lets a request name a `layerN_files` upstream directory for a
// layer that is never published (e.g. floor=15, floor=-10), silently
// widening the tile proxy's surface (and its persistent disk cache, see
// TILE_CACHE_DIR) past the domain the whole feature models, purely because
// the two bounds were never kept in sync despite the comment's own claim.

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

function findRoute(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const headers = {};
  let statusCode = 200;
  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    end() {
      return this;
    },
    send() {
      return this;
    },
    json() {
      return this;
    },
  };
}

async function freshModule() {
  vi.resetModules();
  return await import("../routes/mapProxy.js");
}

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("/tiles floor query bound matches WorldMap.tsx's real changeFloor clamp (-1..7)", () => {
  const OUT_OF_RANGE_BUT_PREVIOUSLY_ACCEPTED = ["-17", "-10", "-2", "8", "15", "29"];

  it.each(OUT_OF_RANGE_BUT_PREVIOUSLY_ACCEPTED)(
    "rejects floor=%s (outside the real -1..7 published-layer range) with 400, never reaching getB42Dir",
    async (floor) => {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler(
        { params: { level: "5", tile: "5_5.jpg" }, query: { floor } },
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(mockExecFile).not.toHaveBeenCalled();
    },
  );

  const IN_RANGE = ["-1", "0", "7"];
  it.each(IN_RANGE)(
    "still accepts floor=%s (a real published B42 layer) past validation",
    async (floor) => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (url, init) => {
        if ((init?.method || "GET") === "HEAD") return { ok: true };
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
        };
      });
      mockExecFile.mockImplementation((_file, args, _options, callback) => {
        const url = args[args.length - 1];
        if (url.endsWith("/api/builds/default")) {
          callback(null, {
            stdout: `${JSON.stringify({ directory: "42.20.0", default: true })}\n__CURL_HTTP_STATUS__:200`,
            stderr: "",
          });
          return;
        }
        if (url.includes("/base/layer0.dzi")) {
          callback(null, {
            stdout: `<?xml version="1.0"?><Image TileSize="2048" Overlap="0" Format="jpg"><Size Width="2318656" Height="1019040"/></Image>\n__CURL_HTTP_STATUS__:200`,
            stderr: "",
          });
          return;
        }
        if (url.includes("/base/map_info.json")) {
          callback(null, {
            stdout: `${JSON.stringify({ x0: 1040384, y0: -139296, sqr: 128, skip: 0 })}\n__CURL_HTTP_STATUS__:200`,
            stderr: "",
          });
          return;
        }
        callback(new Error(`unexpected curl URL in test: ${url}`));
      });
      try {
        const { default: router } = await freshModule();
        const handler = findRoute(router, "/tiles/:level/:tile", "get");
        const res = makeRes();
        // Distinct level/tile per floor value avoids colliding with another
        // test's on-disk tile cache entry for the same coordinate.
        await handler(
          {
            params: { level: "6", tile: `${floor === "-1" ? 1 : floor === "0" ? 2 : 3}_1.jpg` },
            query: { floor },
          },
          res,
        );
        expect(res.statusCode).toBe(200);
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});
