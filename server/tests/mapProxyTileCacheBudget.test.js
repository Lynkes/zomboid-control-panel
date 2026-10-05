import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import http from "http";
import path from "path";

// DISKFILL (security sweep 2026-10-04): /api/map/tiles|toptiles|b41tiles are
// auth-exempt (<img> tags) and every distinct tile they proxied was written
// to <dataDir>/map-tiles-cache forever -- no eviction, no size bound -- and
// kept in a 500-entry in-memory LRU with no byte bound (~500 MB of ~1 MB
// tiles). The verifier filled ~290 MB per anonymous IP per rate-limit
// window, before first-run setup or after it, auth on, no token.
//
// Promoted from the verifier repro: the real authService middleware (admin
// account, auth fully on) in front of the real mapProxy router, plain HTTP
// with no credentials. Only tiles.pzmap.org is faked. The budgets are shrunk
// through the test hook so eviction is observable without writing a GiB;
// on a build without the hook (the unbounded one) these assertions fail.

const KIB = 1024;
const TILE = Buffer.alloc(64 * KIB, 0x41);
const BIG_TILE = Buffer.alloc(300 * KIB, 0x42);
const DISK_MAX = 256 * KIB; // 4 tiles
const MEM_MAX = 128 * KIB; // 2 tiles
const realFetch = globalThis.fetch;
let upstreamCalls = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://tiles.pzmap.org/")) {
    upstreamCalls++;
    const body = u.endsWith("/9999_9999.jpg") ? BIG_TILE : TILE;
    return new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  return realFetch(url, opts);
};

const { getDataPaths } = await import("../utils/paths.js");
const TILES = path.join(getDataPaths().dataDir, "map-tiles-cache");

// Residue from an older, unbounded version: 12 tiles (oldest first by
// mtime) plus a write a crash interrupted. Must exist before mapProxy.js
// is imported and scans it.
const RESIDUE_DIR = path.join(TILES, "b41", "15");
fs.mkdirSync(RESIDUE_DIR, { recursive: true });
const residueBase = Date.now() / 1000 - 3600;
for (let i = 0; i < 12; i++) {
  const f = path.join(RESIDUE_DIR, `${i}_0.jpg`);
  fs.writeFileSync(f, TILE);
  fs.utimesSync(f, residueBase + i, residueBase + i);
}
const STALE_TMP = path.join(RESIDUE_DIR, "0_1.jpg.123.456.abcd.tmp");
fs.writeFileSync(STALE_TMP, TILE);

const init = await import("../database/init.js");
const { default: authService } = await import("../services/auth.js");
const mapProxy = await import("../routes/mapProxy.js");
mapProxy._setTileCacheLimitsForTests?.({ diskMaxBytes: DISK_MAX, memMaxBytes: MEM_MAX });

let server;
let baseUrl;

function du() {
  let total = 0;
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        files.push(path.relative(TILES, full));
        total += fs.statSync(full).size;
      }
    }
  };
  walk(TILES);
  return { total, files };
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

async function getTile(p) {
  const res = await realFetch(`${baseUrl}${p}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, cache: res.headers.get("x-tile-cache"), length: body.length };
}

beforeAll(async () => {
  await init.initDatabase();
  await authService.init();
  await authService.createUser("admin", "correct-horse-battery-staple-9", "admin");
  expect(await authService.isAuthEnabled()).toBe(true);

  const app = express();
  app.use(authService.middleware());
  app.use("/api/map", mapProxy.default);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
});

describe("map tile proxy cache is size-bounded (anonymous callers)", () => {
  it("trims a cache that already grew past the budget, oldest first, and drops interrupted writes", async () => {
    const r = await getTile("/api/map/b41tiles/16/100_0.jpg");
    expect(r.status).toBe(200);
    const fresh = path.join("b41", "16", "100_0.jpg");
    await waitFor(() => {
      const d = du();
      return d.files.includes(fresh) && d.total <= DISK_MAX;
    });
    const d = du();
    expect(d.total).toBeLessThanOrEqual(DISK_MAX);
    expect(d.files).toContain(fresh);
    expect(fs.existsSync(STALE_TMP)).toBe(false);
    // Least recently used goes first: the oldest residue is gone, the newest kept.
    expect(d.files).not.toContain(path.join("b41", "15", "0_0.jpg"));
    expect(d.files).toContain(path.join("b41", "15", "11_0.jpg"));
  });

  it("many distinct tiles from one anonymous caller never grow the disk cache past its budget", async () => {
    const before = upstreamCalls;
    const N = 40;
    for (let i = 0; i < N; i++) {
      const r = await getTile(`/api/map/b41tiles/16/${200 + i}_${i}.jpg`);
      expect(r.status).toBe(200);
      expect(r.length).toBe(TILE.length);
    }
    expect(upstreamCalls - before).toBe(N);
    const last = path.join("b41", "16", `${200 + N - 1}_${N - 1}.jpg`);
    await waitFor(() => {
      const d = du();
      return d.files.includes(last) && d.total <= DISK_MAX;
    });
    const d = du();
    expect(d.files).toContain(last);
    expect(d.total).toBeLessThanOrEqual(DISK_MAX);
    expect(d.files.length).toBeLessThanOrEqual(DISK_MAX / TILE.length);
  });

  it("the in-memory tier is bounded by bytes, not only by entry count", async () => {
    // Memory holds the two most recent tiles of the previous test (128 KiB).
    const newest = await getTile("/api/map/b41tiles/16/239_39.jpg");
    expect(newest.cache).toBe("hit-mem");
    const third = await getTile("/api/map/b41tiles/16/237_37.jpg");
    expect(third.cache).not.toBe("hit-mem");
    const first = await getTile("/api/map/b41tiles/16/200_0.jpg");
    expect(first.cache).toBe("miss"); // evicted from both tiers, refetched upstream
  });

  it("a tile bigger than the whole budget is served but never kept", async () => {
    const r = await getTile("/api/map/b41tiles/16/9999_9999.jpg");
    expect(r.status).toBe(200);
    expect(r.length).toBe(BIG_TILE.length);
    // Give a (wrong) fire-and-forget write time to land before checking.
    await new Promise((res) => setTimeout(res, 300));
    expect(du().files).not.toContain(path.join("b41", "16", "9999_9999.jpg"));
    const again = await getTile("/api/map/b41tiles/16/9999_9999.jpg");
    expect(again.cache).toBe("miss");
  });
});
