import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import http from "http";
import path from "path";

// DISKFILL (security sweep 2026-10-04): GET /api/mods/thumbnail/:id is
// auth-exempt (<img> tags), and it used to resolve and PERMANENTLY cache the
// Steam preview of any Workshop id it was handed -- untracked, and of any
// game (the verifier used Garry's Mod items, consumer_app_id 4000). One
// anonymous IP wrote ~300 x 1 MB files per rate-limit window into
// <dataDir>/mod-thumbnails, with no eviction, filling the data volume.
//
// Promoted from the verifier repro: the real database/init.js (this suite's
// per-file temp dataDir), the real authService with an admin account (auth
// fully on), its real middleware in front of the real mods router, plain
// HTTP with no Authorization header and no cookie. Only Steam is faked.

const realFetch = globalThis.fetch;
const STEAM_API = "https://api.steampowered.com/";
const STEAM_CDN = "https://images.steamusercontent.com/";
const IMG = Buffer.alloc(64 * 1024, 0xff);
const outbound = { api: 0, cdn: 0 };
let steamAppId = 108600;
let steamOk = true;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(STEAM_API)) {
    outbound.api++;
    if (!steamOk) return new Response("down", { status: 503 });
    const id = new URLSearchParams(String(opts.body)).get("publishedfileids[0]");
    return new Response(
      JSON.stringify({
        response: {
          publishedfiledetails: [
            {
              publishedfileid: id,
              result: 1,
              consumer_app_id: steamAppId,
              preview_url: `${STEAM_CDN}ugc/${id}/X/`,
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (u.startsWith(STEAM_CDN)) {
    outbound.cdn++;
    return new Response(IMG, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": String(IMG.length) },
    });
  }
  return realFetch(url, opts);
};

const init = await import("../database/init.js");
const { default: authService } = await import("../services/auth.js");
const { default: modsRouter, getThumbnailResolutionStatus } = await import("../routes/mods.js");
const { getDataPaths } = await import("../utils/paths.js");

let server;
let baseUrl;
let cacheDir;

function cacheFiles() {
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir).filter((n) => n.endsWith(".img"));
}

async function getThumb(id) {
  const res = await realFetch(`${baseUrl}/api/mods/thumbnail/${id}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body };
}

beforeAll(async () => {
  await init.initDatabase();
  await authService.init();
  await authService.createUser("admin", "correct-horse-battery-staple-9", "admin");
  expect(await authService.needsSetup()).toBe(false);
  expect(await authService.isAuthEnabled()).toBe(true);

  const app = express();
  app.use(authService.middleware());
  app.use("/api/mods", modsRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  cacheDir = path.join(getDataPaths().dataDir, "mod-thumbnails");
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => {
  outbound.api = 0;
  outbound.cdn = 0;
  steamAppId = 108600;
  steamOk = true;
});

describe("GET /api/mods/thumbnail/:id, anonymous", () => {
  it("control: an ordinary mods route is 401 without credentials", async () => {
    const res = await realFetch(`${baseUrl}/api/mods/status`);
    expect(res.status).toBe(401);
  });

  it("an untracked id gets the placeholder with no Steam call and no disk write, even for a real PZ item", async () => {
    const before = cacheFiles().length;
    for (let i = 0; i < 25; i++) {
      const r = await getThumb(String(3_000_000_000 + i));
      expect(r.status).toBe(200);
      expect(r.type).toBe("image/gif");
      // Not cacheable: the real image must show up once the mod is tracked.
      expect(r.cache).toBe("no-store");
    }
    expect(outbound).toEqual({ api: 0, cdn: 0 });
    expect(cacheFiles().length).toBe(before);
  });

  it("an untracked id of another game (consumer_app_id 4000) is not fetched or cached either", async () => {
    steamAppId = 4000;
    const r = await getThumb("160250458");
    expect(r.type).toBe("image/gif");
    expect(outbound).toEqual({ api: 0, cdn: 0 });
    expect(fs.existsSync(path.join(cacheDir, "160250458.img"))).toBe(false);
  });

  it("a tracked id whose Workshop item belongs to another game is never downloaded or cached", async () => {
    await init.addTrackedMod("4000000001", "not a PZ item");
    steamAppId = 4000;
    const r = await getThumb("4000000001");
    expect(r.type).toBe("image/gif");
    expect(outbound.api).toBe(1);
    expect(outbound.cdn).toBe(0);
    expect(fs.existsSync(path.join(cacheDir, "4000000001.img"))).toBe(false);
  });

  it("a tracked Project Zomboid mod is still fetched once and cached (unchanged behaviour)", async () => {
    await init.addTrackedMod("4000000002", "real PZ mod");
    const first = await getThumb("4000000002");
    expect(first.type).toBe("image/jpeg");
    expect(first.body.length).toBe(IMG.length);
    expect(outbound).toEqual({ api: 1, cdn: 1 });
    expect(fs.statSync(path.join(cacheDir, "4000000002.img")).size).toBe(IMG.length);

    const second = await getThumb("4000000002");
    expect(second.type).toBe("image/jpeg");
    expect(outbound).toEqual({ api: 1, cdn: 1 }); // served from disk
  });

  it("the remembered-failure map is bounded, however many tracked mods fail", async () => {
    steamOk = false;
    const ids = Array.from({ length: 1100 }, (_, i) => String(5_000_000_000 + i));
    for (const id of ids) await init.addTrackedMod(id, null);
    for (let i = 0; i < ids.length; i += 25) {
      const rs = await Promise.all(ids.slice(i, i + 25).map(getThumb));
      for (const r of rs) expect(r.type).toBe("image/gif");
    }
    const status = await getThumbnailResolutionStatus();
    expect(status.failing).toBeGreaterThan(0);
    expect(status.failing).toBeLessThanOrEqual(1000);
  });
});
