import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import http from "http";
import path from "path";

// Security sweep 2026-10-05, H3: GET /api/mods/thumbnail/:id (auth-exempt,
// <img> tags) served any <dataDir>/mod-thumbnails/<id>.img already on disk
// before it checked that the id is tracked. Versions before the DISKFILL fix
// cached a thumbnail for any Workshop id an anonymous caller named, so those
// files stayed on the data volume for good and kept being served to anyone.
// The route now checks the id first, and files for ids no server tracks are
// pruned: at startup, and in the background when the cache is touched.
//
// The real database/init.js (this file's own temp dataDir), the real
// authService with an admin account, its middleware in front of the real
// mods router, plain HTTP with no credentials. Steam is never reached.

const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, opts) => {
  outbound.push(String(url));
  return new Response("no network in this test", { status: 503 });
};

const init = await import("../database/init.js");
const { default: authService } = await import("../services/auth.js");
const mods = await import("../routes/mods.js");
const { getDataPaths } = await import("../utils/paths.js");

const STALE_BYTES = Buffer.from("stale thumbnail from an older version");
let server;
let baseUrl;
let cacheDir;
let serverA;
let serverB;

function cacheFile(name) {
  return path.join(cacheDir, name);
}

function seed(name, { ageMs = 0 } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile(name), STALE_BYTES);
  if (ageMs) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(cacheFile(name), then, then);
  }
}

async function getThumb(id) {
  const res = await realFetch(`${baseUrl}/api/mods/thumbnail/${id}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body };
}

async function waitUntilGone(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !fs.existsSync(file);
}

beforeAll(async () => {
  await init.initDatabase();
  await authService.init();
  await authService.createUser("admin", "correct-horse-battery-staple-9", "admin");
  expect(await authService.isAuthEnabled()).toBe(true);

  serverA = await init.createServer({ name: "A", serverName: "a" });
  serverB = await init.createServer({ name: "B", serverName: "b" });
  await init.setActiveServer(serverB.id);
  await init.addTrackedMod("3200000002", "tracked on B only");
  await init.setActiveServer(serverA.id);
  await init.addTrackedMod("3200000001", "tracked on A");

  const app = express();
  app.use(authService.middleware());
  app.use("/api/mods", mods.default);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  cacheDir = path.join(getDataPaths().dataDir, "mod-thumbnails");
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe("GET /api/mods/thumbnail/:id with a file already on disk", () => {
  it("never serves a cached file for an untracked id, and prunes it in the background", async () => {
    seed("3100000001.img");
    const r = await getThumb("3100000001");
    expect(r.type).toBe("image/gif");
    expect(r.cache).toBe("no-store");
    expect(r.body.equals(STALE_BYTES)).toBe(false);
    expect(await waitUntilGone(cacheFile("3100000001.img"))).toBe(true);
    expect(outbound).toEqual([]);
  });

  it("still serves a tracked mod's cached file from disk", async () => {
    seed("3200000001.img");
    const r = await getThumb("3200000001");
    expect(r.type).toBe("image/jpeg");
    expect(r.body.equals(STALE_BYTES)).toBe(true);
    expect(outbound).toEqual([]);
  });

  it("serves only the active server's tracked mods", async () => {
    seed("3200000002.img");
    const r = await getThumb("3200000002");
    expect(r.type).toBe("image/gif");
    expect(r.cache).toBe("no-store");
  });
});

describe("pruneModThumbnailCache()", () => {
  it("deletes files for ids no server tracks and abandoned temp files, and keeps the rest", async () => {
    seed("3300000001.img"); // never tracked: an anonymous caller's
    seed("3300000002.img"); // tracked once, untracked since
    seed("3200000001.img"); // tracked on the active server
    seed("3200000002.img"); // tracked on another server
    seed("3300000003.img.tmp-123-456", { ageMs: 2 * 60 * 60 * 1000 }); // a write that never finished
    seed("3200000001.img.tmp-123-789"); // a write that may still be in flight
    seed("notes.txt"); // nothing this cache wrote

    const result = await mods.pruneModThumbnailCache();

    expect(fs.existsSync(cacheFile("3300000001.img"))).toBe(false);
    expect(fs.existsSync(cacheFile("3300000002.img"))).toBe(false);
    expect(fs.existsSync(cacheFile("3300000003.img.tmp-123-456"))).toBe(false);
    expect(fs.existsSync(cacheFile("3200000001.img"))).toBe(true);
    expect(fs.existsSync(cacheFile("3200000002.img"))).toBe(true);
    expect(fs.existsSync(cacheFile("3200000001.img.tmp-123-789"))).toBe(true);
    expect(fs.existsSync(cacheFile("notes.txt"))).toBe(true);
    expect(result).toEqual({ removed: 3, kept: 2 });
  });

  it("drops a mod's thumbnail once no server tracks it", async () => {
    seed("3200000001.img");
    expect(await init.removeTrackedMod("3200000001")).toBe(true);
    await mods.pruneModThumbnailCache();
    expect(fs.existsSync(cacheFile("3200000001.img"))).toBe(false);
  });

  it("is a no-op without a cache folder", async () => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    expect(await mods.pruneModThumbnailCache()).toEqual({ removed: 0, kept: 0 });
  });
});
