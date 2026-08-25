import express from "express";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";
import { getActiveServer } from "../database/init.js";
import { listPersistedVehicles } from "../utils/vehiclesDb.js";
const log = createLogger("API:MapProxy");
const execFileAsync = promisify(execFile);

const router = express.Router();

// ROLE NOTE (role-sweep, not this file's original author): no requireRole
// anywhere in this file, deliberately, on two different grounds:
//   - /tiles/:level/:tile, /toptiles/:level/:tile, /b41tiles/:level/:tile
//     are already exempted from the central login gate entirely (see
//     authService.middleware(), which matches /api/map/tiles/,
//     /api/map/toptiles/, /api/map/b41tiles/ before req.user is ever set —
//     they're loaded via <img> tags, which can't send an auth header). A
//     role check here would be dead code: req.user is never populated for
//     these paths in the first place.
//   - /resolve and /vehicles ARE behind the login gate (any authenticated
//     request reaches them) and stay open to every role on purpose: viewing
//     the world map and live vehicle positions is exactly the kind of thing
//     a moderator wants for locating a reported incident, and neither
//     returns anything sensitive or mutates any state.
//
// ─── Persistent disk-backed tile cache ───────────────────────────────────
// A given PZ map build's tiles never change once published, so unlike a
// typical HTTP cache these never need to expire — once a tile has been
// fetched from the upstream tile host it's cached on disk indefinitely.
// Over time this turns the proxy into a self-hosted mirror of whatever
// parts of the map players have actually looked at, with zero upfront
// download and no dependency on the upstream host for anything already
// cached. A small in-memory LRU sits in front of disk to avoid a
// filesystem read on every request for hot tiles.
const TILE_CACHE_DIR = path.join(getDataPaths().dataDir, "map-tiles-cache");
const MEM_CACHE_MAX = 500;
const memCache = new Map(); // relPath -> { buffer, contentType }

function memCacheGet(relPath) {
  const entry = memCache.get(relPath);
  if (!entry) return null;
  // Refresh LRU position
  memCache.delete(relPath);
  memCache.set(relPath, entry);
  return entry;
}

function memCachePut(relPath, buffer, contentType) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey !== undefined) memCache.delete(oldestKey);
  }
  memCache.set(relPath, { buffer, contentType });
}

function diskPathFor(relPath) {
  return path.join(TILE_CACHE_DIR, relPath);
}

async function readDiskCache(relPath) {
  try {
    return await fs.promises.readFile(diskPathFor(relPath));
  } catch {
    return null;
  }
}

// Fire-and-forget: a disk cache write failing (permissions, full disk) just
// means we re-fetch from upstream next time — never block the response on it.
function writeDiskCacheAsync(relPath, buffer) {
  const dest = diskPathFor(relPath);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.promises
    .mkdir(path.dirname(dest), { recursive: true })
    .then(() => fs.promises.writeFile(tmp, buffer))
    .then(() => fs.promises.rename(tmp, dest))
    .catch((err) => {
      log.debug(`Disk tile cache write failed for ${relPath}: ${err.message}`);
      fs.promises.unlink(tmp).catch(() => {});
    });
}

// ─── B42 map version resolution ──────────────────────────────────────────────
// b42map.com has migrated to pzmap.org. The old map.projectzomboid.com host
// now redirects there, adding another failure point for direct browser loads.
//
// pzmap.org split into two hosts: the site root and its build-list API stayed
// at pzmap.org, but tiles and every per-build descriptor under a version
// directory (map_info.json, layer0.dzi, base_top/layer0.dzi, and the tiles
// themselves) moved to tiles.pzmap.org AND dropped the /maps path segment:
//   old (404s now): https://pzmap.org/maps/<version>/base/layer<floor>_files/<level>/<tile>
//   new:            https://tiles.pzmap.org/<version>/base/layer<floor>_files/<level>/<tile>
//
// build_list.json (what this file used to fetch for the build list) is DEAD,
// not just blocked -- it's a genuine 404 on both hosts. pzmap.org's own
// current bundle (read directly out of its shipped JS) fetches
// GET pzmap.org/api/builds/default (the build pzmap.org itself is showing
// right now) and GET pzmap.org/api/builds (the full list, oldest-first --
// NOT newest-first, unlike the old build_list.json's assumed ordering) as a
// fallback when no entry is flagged default. See fetchBuildDefault() /
// fetchBuildList() below.
//
// Separately: every JSON/XML/HTML descriptor path this file needs on EITHER
// host (pzmap.org/api/builds*, tiles.pzmap.org/<dir>/base/layer0.dzi,
// .../map_info.json, .../base_top/layer0.dzi) is behind a Cloudflare
// bot-management challenge that blocks Node's own TLS stack outright --
// confirmed identically for both `fetch` and the `https` module, so this is
// not a fetch-vs-https question, it's every HTTP client built on Node's TLS
// stack. curl gets through this challenge far more reliably than either --
// confirmed independently by two of us, across every path on both hosts,
// many times over. Raw tile BYTES (.../layer<floor>_files/<level>/<tile>.jpg,
// what serveTile() below fetches) are NOT behind this rule for any client
// tested, including plain Node fetch -- that's why tile serving already
// works today even though discovery doesn't; don't route serveTile()'s
// per-tile hot path through curl, there's no need and spawning a process
// per tile would be a real perf regression.
//
// What curl's success does NOT depend on, despite an earlier theory here:
// a specific User-Agent string. We measured curl passing with a spoofed
// full browser UA, and separately passing with this file's own honest
// identifying UA below -- and, hours apart, saw one of those SAME requests
// briefly 403 for no header-shaped reason at all. Whatever gates these
// paths is probabilistic and/or IP- or time-scored, not a deterministic
// per-request rule we can satisfy by getting a header right. So:
// getB42Map() below treats every curl call as expected to occasionally (or
// even permanently, if the heuristic tightens) fail -- caches a good
// result, never caches a failure as if it were an answer, and always keeps
// the hardcoded fallback as a real last resort. Do not build logic here
// that assumes a successful resolve today predicts one tomorrow.
const PZ_MAP_ROOT = "https://pzmap.org"; // site root + the build-list API — unchanged by the migration
const PZ_TILES_ROOT = "https://tiles.pzmap.org"; // tiles + per-build descriptors, no /maps segment

// Sent on principle (this is genuinely us, not a spoofed identity) and
// because SOME plausible User-Agent is still better than none for a client
// that might get more scrutiny with no header at all -- see the header
// comment above for why this string is NOT load-bearing the way an earlier
// version of this comment claimed. Keep it identifying; do not swap in a
// browser-spoofing string on the theory that it's required, that theory
// didn't hold up.
const CURL_DISCOVERY_UA =
  "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)";
const CURL_TIMEOUT_S = 8;
const CURL_STATUS_MARKER = "\n__CURL_HTTP_STATUS__:";

// Runs curl as a subprocess to reach a discovery URL Node's own TLS stack
// cannot (see the comment above). ALWAYS an argument array, NEVER shell:true
// and NEVER string-interpolated — the directory segment of these URLs
// ultimately comes from a remote JSON document (pzmap.org's own response),
// and this floor has already shipped one shell:true incident. `--` before
// the URL stops curl from ever parsing it as a flag. Returns a fetch()-like
// {ok, status, text} shape so callers don't need two code paths. Missing
// curl (ENOENT) and a request failure both surface as a thrown Error —
// callers must treat that as a degradation to the next tier, never as a
// user-visible error.
async function fetchViaCurl(url) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "curl",
      [
        "-s",
        "--max-time",
        String(CURL_TIMEOUT_S),
        "-A",
        CURL_DISCOVERY_UA,
        "-w",
        `${CURL_STATUS_MARKER}%{http_code}`,
        "--",
        url,
      ],
      { timeout: (CURL_TIMEOUT_S + 2) * 1000, maxBuffer: 20 * 1024 * 1024 },
    ));
  } catch (err) {
    throw new Error(
      err.code === "ENOENT"
        ? "curl is not available on this host"
        : `curl request failed: ${err.message}`,
    );
  }
  const idx = stdout.lastIndexOf(CURL_STATUS_MARKER);
  if (idx === -1) throw new Error("curl output missing its status marker");
  const status = Number(stdout.slice(idx + CURL_STATUS_MARKER.length).trim());
  return {
    ok: status >= 200 && status < 300,
    status,
    text: stdout.slice(0, idx),
  };
}

// 42.19.0 was removed from map.projectzomboid.com - /maps/42.19.0/base/ now
// 404s in its entirety, so the previous fallback could not serve a single tile.
// It is still listed in the build list, so "listed" is not evidence a build is
// still rendered; only the fallback needs to be a build that actually exists.
const B42_DIR_FALLBACK = "42.20.0";
const B42_DIR_TTL_MS = 24 * 60 * 60 * 1000; // re-resolve at most once per 24 h
const B42_DIR_RETRY_MS = 5 * 60 * 1000; // ...but retry a failed resolve sooner
// Geometry of B42_DIR_FALLBACK, used only when layer0.dzi can't be fetched.
// x0/y0/sqr/scale are the isometric projection origin, copied from 42.20.0's
// own base/map_info.json (skip:0 => scale 1<<0 = 1). Note x0 and scale both
// differ from 42.19.0's, so the directory cannot be bumped on its own without
// putting every player marker in the wrong place.
const B42_GEOMETRY_FALLBACK = {
  tileSize: 2048,
  width: 2318656,
  height: 1019040,
  maxLevel: 22,
  // The fallback directory is 42.20.0, and the same inhabited-area probes
  // used by discovery resolve through level 22. Keep the full DZI ceiling
  // available when build discovery is temporarily blocked. Individual
  // sparse/edge 404s still use WorldMap's coarser-tile fallback.
  renderedMaxLevel: 22,
  x0: 1040384,
  y0: -139296,
  sqr: 128,
  scale: 1,
};

// The projection origin is NOT derivable from the image dimensions: 42.20.0 is
// exactly 2x the height of 42.19.0 but 4032 px wider, because the renderer
// crops/pads each build independently. The map service (tiles.pzmap.org)
// publishes the real origin per build in base/map_info.json and its own viewer projects with
//   imageX = (x0 + (sx - sy) * sqr / 2) / scale
//   imageY = (y0 + (sx + sy) * sqr / 4) / scale
// where scale = 1 << skip. Scaling a previous build's origin by the width
// ratio instead puts markers ~2300 px (~36 tiles) west of where they are.
async function fetchMapProjection(directory) {
  try {
    // JSON descriptor path — Node's own TLS stack is challenged here, curl
    // isn't (see CURL_DISCOVERY_UA above).
    const resp = await fetchViaCurl(
      `${PZ_TILES_ROOT}/${directory}/base/map_info.json`,
    );
    if (!resp.ok) return null;
    const info = JSON.parse(resp.text);
    const x0 = Number(info?.x0);
    const y0 = Number(info?.y0);
    const sqr = Number(info?.sqr);
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !sqr) return null;
    const skip = Number(info?.skip);
    return { x0, y0, sqr, scale: 1 << (Number.isFinite(skip) ? skip : 0) };
  } catch {
    return null;
  }
}
// Map builds are not all rendered at the same resolution: 42.19.0 is
// TileSize=1024 / 1157312x509520, while 42.20.0 doubled to TileSize=2048 /
// 2318656x1019040. Nothing about the geometry can be assumed, so read it from
// the build's own DZI descriptor and hand it to the client.
async function fetchMapGeometry(directory) {
  try {
    // XML descriptor path — same Cloudflare-vs-Node's-TLS-stack situation as
    // fetchMapProjection() above. Runs alongside it (Promise.all, not a
    // sequential await) since they're independent curl subprocess calls —
    // each one pays its own connection setup cost, so serializing them here
    // just adds latency to every cold discovery for no correctness benefit.
    const [resp, projection] = await Promise.all([
      fetchViaCurl(`${PZ_TILES_ROOT}/${directory}/base/layer0.dzi`),
      fetchMapProjection(directory),
    ]);
    if (!resp.ok) return null;
    const xml = resp.text;
    const tileSize = Number(xml.match(/TileSize="(\d+)"/)?.[1]);
    const width = Number(xml.match(/Width="(\d+)"/)?.[1]);
    const height = Number(xml.match(/Height="(\d+)"/)?.[1]);
    if (!tileSize || !width || !height) return null;
    return {
      tileSize,
      width,
      height,
      maxLevel: Math.ceil(Math.log2(Math.max(width, height))),
      ...(projection || {}),
    };
  } catch {
    return null;
  }
}

// A brand-new PZ build's tiles can be listed as the default entry in the
// build list before the map service has actually finished
// rendering full world coverage for it. Probing a few inhabited-area tiles
// lets us detect "listed but not rendered yet" and fall back to the previous
// build instead of showing an empty map.
//
// The probe coordinates are derived from the build's own geometry rather than
// hardcoded: a fixed `15/9_3.jpg`-style path is only meaningful for a
// TileSize=1024 build and silently false-negatives on a 2048 one, which would
// pin every install to an outdated build forever.
const COVERAGE_PROBE_FRACTIONS = [
  [0.51, 0.4],
  [0.56, 0.45],
  [0.61, 0.5],
];
let _b42Map = null;
let _b42DirFetchedAt = 0;
// A cold cache means every concurrent tile request on the same page load
// calls getB42Map() before any of them has finished resolving — without
// this, EACH ONE independently reruns the full discovery (its own
// fetchBuildDefault/fetchBuildList/fetchMapGeometry/hasTileCoverage curl
// round trips) instead of sharing the one already in flight. Measured: 80
// concurrent cold tile requests took 7.3s with this uncoalesced; under 1s
// once discovery was already warm. Same shape as THUMB_INFLIGHT in mods.js.
let _b42ResolvePromise = null;
// Tracks WHY the current _b42Map is what it is, for the worldmap diagnostic.
// The fallback directory can coincidentally match the directory a real
// dynamic resolve would have picked (it does today), so the directory string
// alone cannot tell a healthy resolve apart from a permanently broken one —
// this is what makes the fallback silent without an explicit source flag.
let _b42Source = null; // "dynamic" | "fallback" — contract fixed in conv-mapbuild, shared with getB42ResolutionStatus()'s consumers
let _b42FallbackReason = null; // why we're not on "dynamic", or null when the last resolution attempt succeeded

// A HEAD probe against a tile BYTE path, not a JSON/XML descriptor — this is
// the one discovery request that's fine on plain Node fetch (see the
// perf-regression note on CURL_DISCOVERY_UA above): tile bytes aren't behind
// the Cloudflare descriptor-path challenge for any client tested.
async function probeLevelHasCoverage(directory, geometry, level) {
  const levelScale = 2 ** (geometry.maxLevel - level);
  const levelW = Math.ceil(geometry.width / levelScale);
  const levelH = Math.ceil(geometry.height / levelScale);
  for (const [fx, fy] of COVERAGE_PROBE_FRACTIONS) {
    const col = Math.floor((levelW * fx) / geometry.tileSize);
    const row = Math.floor((levelH * fy) / geometry.tileSize);
    try {
      const resp = await fetch(
        `${PZ_TILES_ROOT}/${directory}/base/layer0_files/${level}/${col}_${row}.jpg`,
        {
          method: "HEAD",
          signal: AbortSignal.timeout(4000),
          headers: {
            "User-Agent":
              "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
          },
        },
      );
      if (resp.ok) return true;
    } catch {
      // Treat as not-covered and try the next probe tile.
    }
  }
  return false;
}

async function hasTileCoverage(directory, geometry) {
  return probeLevelHasCoverage(
    directory,
    geometry,
    Math.max(0, geometry.maxLevel - 6),
  );
}

// geometry.maxLevel (fetchMapGeometry, above) is Math.ceil(log2(max(width,
// height))) — the depth a FULL Deep Zoom pyramid would need for an image of
// that size, computed from the DZI descriptor's own dimensions. It is not
// evidence the tile host actually rendered that deep: level 21 at 1024px
// tiles is roughly 563,000 tiles for one floor, so real coverage falls well
// short and the client (WorldMap.tsx) was clamping to this inflated ceiling
// and asking for tiles that 404 across most of the map — see GH#109 /
// conv-gh109-worldmap-black. hasTileCoverage() above already establishes,
// empirically, that maxLevel-6 is deep enough to find real tiles at these
// probe points; that's what gates picking this directory at all, so it's a
// known-good floor here, not a guess. Binary search the [maxLevel-6,
// maxLevel] gap (at most a handful of HEAD requests, same probe points,
// run once per directory resolve and cached alongside the rest of the
// geometry — see B42_DIR_TTL_MS) for the deepest level any probe tile still
// resolves at, and report that as the depth a client should actually be
// allowed to zoom to.
async function discoverRenderedMaxLevel(directory, geometry) {
  const floor = Math.max(0, geometry.maxLevel - 6);
  let lo = floor; // known covered — hasTileCoverage just confirmed it
  let hi = geometry.maxLevel;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (await probeLevelHasCoverage(directory, geometry, mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

// The top-down (base_top) view is rendered separately from the isometric base
// and does not use the same image format across builds: 42.19.0 publishes webp
// while 42.20.0 publishes jpg. Requesting the wrong extension is a hard 404, so
// read the format from the build's own base_top descriptor.
const TOP_FORMAT_FALLBACK = "jpg";
const TOP_CONTENT_TYPES = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const _topFormatCache = new Map(); // directory -> format
// Same coalescing problem and fix as _b42ResolvePromise above: a cold cache
// means every concurrent toptiles request independently curls the same
// base_top/layer0.dzi descriptor instead of sharing the one in flight.
const _topFormatInflight = new Map(); // directory -> Promise<format>

async function getB42TopFormat(directory) {
  const cached = _topFormatCache.get(directory);
  if (cached) return cached;
  const pending = _topFormatInflight.get(directory);
  if (pending) return pending;
  const resolvePromise = resolveB42TopFormat(directory).finally(() => {
    _topFormatInflight.delete(directory);
  });
  _topFormatInflight.set(directory, resolvePromise);
  return resolvePromise;
}

async function resolveB42TopFormat(directory) {
  try {
    // XML descriptor path — curl, not fetch, same reason as fetchMapGeometry.
    const resp = await fetchViaCurl(
      `${PZ_TILES_ROOT}/${directory}/base_top/layer0.dzi`,
    );
    if (resp.ok) {
      const xml = resp.text;
      const format = xml.match(/Format="(\w+)"/)?.[1]?.toLowerCase();
      if (format && TOP_CONTENT_TYPES[format]) {
        _topFormatCache.set(directory, format);
        return format;
      }
    }
  } catch {
    // Fall through to the default below.
  }
  return TOP_FORMAT_FALLBACK;
}

// pzmap.org's own bundle calls this first: the build it is showing right
// now, computed upstream so we don't need to re-derive "current" from list
// order at all. One request instead of a walk — this is the fast, preferred
// path; fetchBuildList() below is the fallback for when this build itself
// isn't usable yet (see hasTileCoverage's "listed but not rendered" note).
async function fetchBuildDefault() {
  const resp = await fetchViaCurl(`${PZ_MAP_ROOT}/api/builds/default`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for /api/builds/default`);
  }
  const entry = JSON.parse(resp.text);
  if (!entry?.directory) {
    throw new Error("/api/builds/default response had no directory");
  }
  return entry;
}

// Full build list. Confirmed directly against the live endpoint: entries
// are OLDEST-first (id 1 is the ancient 0.1.5 build) — the opposite of what
// the old build_list.json's ordering was assumed to be. getB42Map() reverses
// this before walking it; walking it forward would only ever reach OLDER
// builds than whatever's already resolved, never a build shipped after it.
async function fetchBuildList() {
  const resp = await fetchViaCurl(`${PZ_MAP_ROOT}/api/builds`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for /api/builds`);
  }
  const list = JSON.parse(resp.text);
  if (!Array.isArray(list)) {
    throw new Error("/api/builds response was not an array");
  }
  return list;
}

// The full string (not just a prefix) must match a plain version pattern —
// this becomes a disk cache path segment and a URL path segment, so a
// malformed/adversarial value from upstream's own JSON must never reach an
// fs call or a fetch/curl URL unchecked.
function isB42PlusCandidate(directory) {
  return /^4[2-9][\w.\-]*$/.test(directory || "");
}

async function getB42Map() {
  const now = Date.now();
  if (_b42Map && now - _b42DirFetchedAt < B42_DIR_TTL_MS) {
    return _b42Map;
  }
  if (_b42ResolvePromise) return _b42ResolvePromise;
  _b42ResolvePromise = resolveB42Map(now).finally(() => {
    _b42ResolvePromise = null;
  });
  return _b42ResolvePromise;
}

async function resolveB42Map(now) {
  let failureReason = null;

  async function tryResolve(directory) {
    const geometry = await fetchMapGeometry(directory);
    if (!geometry) {
      failureReason = `could not read ${directory}/base/layer0.dzi (discovery request to tiles.pzmap.org was refused)`;
      log.warn(
        `B42 map directory ${directory} has no readable layer0.dzi — trying another build.`,
      );
      return false;
    }
    if (!(await hasTileCoverage(directory, geometry))) {
      failureReason = `${directory} listed but has no rendered tile coverage yet`;
      log.warn(
        `B42 map directory ${directory} listed but has no rendered tile coverage yet — trying another build.`,
      );
      return false;
    }
    const renderedMaxLevel = await discoverRenderedMaxLevel(directory, geometry);
    if (_b42Map?.directory !== directory || _b42Source !== "dynamic") {
      log.info(
        `B42 map directory resolved: ${directory} (${geometry.width}x${geometry.height}, tile ${geometry.tileSize}, max level ${geometry.maxLevel}, rendered max level ${renderedMaxLevel})`,
      );
    }
    _b42Map = { directory, ...geometry, renderedMaxLevel };
    _b42DirFetchedAt = now;
    _b42Source = "dynamic";
    _b42FallbackReason = null;
    return true;
  }

  let alreadyTried = null;
  try {
    // Tier 1a: pzmap.org's own "this is current" flag.
    const def = await fetchBuildDefault();
    if (isB42PlusCandidate(def.directory)) {
      alreadyTried = def.directory;
      if (await tryResolve(def.directory)) return _b42Map;
    } else {
      failureReason = `/api/builds/default returned a non-B42+ directory (${def.directory})`;
    }
  } catch (err) {
    failureReason = err.message;
  }

  try {
    // Tier 1b: the default-flagged build wasn't reachable or isn't
    // rendered yet — walk the rest of the list, newest-first (reversed;
    // see fetchBuildList()'s comment), skipping whatever Tier 1a already
    // tried.
    const list = await fetchBuildList();
    const candidates = list
      .filter(
        (e) => isB42PlusCandidate(e?.directory) && e.directory !== alreadyTried,
      )
      .reverse();
    if (candidates.length === 0 && !alreadyTried) {
      failureReason = failureReason || "/api/builds listed no B42+ candidates";
    }
    for (const entry of candidates) {
      if (await tryResolve(entry.directory)) return _b42Map;
    }
  } catch (err) {
    failureReason = failureReason || err.message;
  }

  // Every path that reaches here is a fallback — both tiers above either
  // threw or ran to completion without a candidate returning early.
  if (_b42Source !== "fallback" || _b42FallbackReason !== failureReason) {
    log.warn(
      `B42 build auto-detect failed (${failureReason || "unknown reason"}) — serving hardcoded fallback ${_b42Map?.directory || B42_DIR_FALLBACK}. This will NOT track the next PZ map build until discovery starts working again.`,
    );
  }
  _b42Map = _b42Map || { directory: B42_DIR_FALLBACK, ...B42_GEOMETRY_FALLBACK };
  _b42Source = "fallback";
  _b42FallbackReason = failureReason || "unknown reason";
  // Stamp the fallback too, not just a successful resolve — otherwise a
  // backend that can never reach pzmap.org/tiles.pzmap.org (e.g. a blocked
  // cluster egress policy) eats the full fetch timeout on every single tile
  // request forever. Retry sooner than a successful resolve so a transient
  // upstream outage doesn't pin us to the fallback build for a whole day.
  _b42DirFetchedAt = now - B42_DIR_TTL_MS + B42_DIR_RETRY_MS;
  return _b42Map;
}

async function getB42Dir() {
  return (await getB42Map()).directory;
}

// For the worldmap diagnostic: reports whether the build currently in use
// was actually discovered dynamically or is the hardcoded fallback, and
// why. Never infer health from the directory string alone (see
// _b42Source's comment above) — call this instead. Contract fixed in
// conv-mapbuild (corrected): { source, directory, reason }, shared with
// debug.js. Two source values only — a client-resolve tier was considered
// and explicitly rejected: Pam could not get a single verified-working
// cross-origin resolve through Cloudflare from any browser she could drive,
// and shipping unverifiable fallback machinery is worse than not having it
// — it's the same "looks healthy, isn't" shape as the defect this whole
// feature exists to fix.
function getB42ResolutionStatus() {
  return {
    source: _b42Source,
    directory: _b42Map?.directory ?? B42_DIR_FALLBACK,
    reason: _b42FallbackReason,
  };
}

// Max time we'll wait for an upstream tile fetch. Without this a slow/dead
// upstream can hold an Express handler open forever, eventually starving the
// pool on a busy map view.
const TILE_FETCH_TIMEOUT_MS = 10_000;

// ─── Circuit breaker for the upstream tile hosts ─────────────────────────
// Without this, a truly dead upstream (e.g. a Cloudflare outage on the map
// host) makes EVERY tile request pay the full timeout+retry cost
// (~10-20s each) with no backpressure, and the map view fires dozens of
// tile requests per pan/zoom — piling up slow handlers. After enough
// consecutive failures we fail fast for a cooldown instead of continuing to
// hammer (and wait on) a host that's already down.
const CIRCUIT_FAILURE_THRESHOLD = 8;
const CIRCUIT_COOLDOWN_MS = 30_000;
let circuitConsecutiveFailures = 0;
let circuitOpenUntil = 0;

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function recordTileSuccess() {
  circuitConsecutiveFailures = 0;
}

function recordTileFailure() {
  circuitConsecutiveFailures++;
  if (
    circuitConsecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
    !isCircuitOpen()
  ) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    log.warn(
      `Tile proxy circuit breaker OPEN for ${CIRCUIT_COOLDOWN_MS / 1000}s after ${circuitConsecutiveFailures} consecutive upstream failures`,
    );
  }
}

async function fetchTileWithTimeout(url) {
  // Node 18+ supports AbortSignal.timeout; older runtimes throw a TypeError
  // which propagates to the caller's catch block and is surfaced as a 502
  // (same shape as any network error).
  return fetch(url, {
    signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS),
    headers: {
      // Some upstreams (Cloudflare on tiles.pzmap.org) return 403/503 when the
      // User-Agent header is missing entirely. Send a neutral identifier.
      "User-Agent":
        "ZomboidControlPanel/1.0 (+https://github.com/fpsacha/zomboid-control-panel)",
      Accept: "image/*,*/*;q=0.8",
    },
  });
}

// Fetch with one retry on transient upstream failures (502/503/504/network).
// 404 is NOT retried — it just means the tile is outside the map bounds.
async function fetchTileWithRetry(url) {
  if (isCircuitOpen()) {
    throw new Error(
      "Tile proxy circuit breaker is open (upstream has been failing repeatedly)",
    );
  }
  try {
    const r = await fetchTileWithTimeout(url);
    if (r.ok || r.status === 404) {
      recordTileSuccess();
      return r;
    }
    if (r.status >= 500 && r.status < 600) {
      // Brief backoff before single retry — Cloudflare 503 on rate-limit
      // typically clears within a few hundred ms.
      await new Promise((res) => setTimeout(res, 250));
      const retried = await fetchTileWithTimeout(url);
      if (retried.ok || retried.status === 404) recordTileSuccess();
      else recordTileFailure();
      return retried;
    }
    // Other 4xx (not 404) isn't a "broken upstream" signal — don't count it
    // toward the circuit breaker.
    return r;
  } catch (err) {
    try {
      await new Promise((res) => setTimeout(res, 250));
      const retried = await fetchTileWithTimeout(url);
      if (retried.ok || retried.status === 404) recordTileSuccess();
      else recordTileFailure();
      return retried;
    } catch (retryErr) {
      recordTileFailure();
      throw retryErr;
    }
  }
}

async function serveTile(req, res, url, contentType, relPath) {
  // Tier 1: in-memory LRU — fastest, no I/O at all.
  const hot = memCacheGet(relPath);
  if (hot) {
    res.set("Content-Type", hot.contentType);
    res.set("Cache-Control", "public, max-age=604800"); // 7 days
    res.set("X-Tile-Cache", "hit-mem");
    res.send(hot.buffer);
    return;
  }

  // Tier 2: disk — this PZ map version's tiles are immutable, so a disk hit
  // means we never have to touch map.projectzomboid.com for this tile again.
  const onDisk = await readDiskCache(relPath);
  if (onDisk) {
    memCachePut(relPath, onDisk, contentType);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=604800");
    res.set("X-Tile-Cache", "hit-disk");
    res.send(onDisk);
    return;
  }

  try {
    const response = await fetchTileWithRetry(url);
    if (!response.ok) {
      // Pass 404 through quietly — that's "tile out of map bounds", not an error.
      // Map upstream 5xx to 502 so the client knows the panel itself is fine.
      const status =
        response.status === 404
          ? 404
          : response.status >= 500
            ? 502
            : response.status;
      return res.status(status).end();
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    memCachePut(relPath, buffer, contentType);
    writeDiskCacheAsync(relPath, buffer);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=604800");
    res.set("X-Tile-Cache", "miss");
    res.send(buffer);
  } catch (err) {
    log.debug(`Tile proxy failed for ${url}: ${err.message}`);
    if (!res.headersSent) res.status(502).end();
  }
}

// Exposes the resolved B42 build: its geometry, which the client needs to
// address tiles at all (tile size and full-res dimensions differ between map
// builds, so neither side can hardcode them), plus enough to build
// direct-to-upstream tile URLs and load them straight from the browser
// instead of always routing through this server's proxy. Some deployments
// (e.g. a Kubernetes cluster with a restrictive Gateway API egress policy)
// block outbound access to tiles.pzmap.org for the panel's own pod
// while the admin's browser has no such restriction — in that case every
// tile-proxy fetch here fails no matter how good the retry/cache/circuit
// breaker logic is, but the browser can just fetch tiles itself.
router.get("/resolve", async (req, res) => {
  const map = await getB42Map();
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    root: PZ_TILES_ROOT,
    b42Dir: map.directory,
    b41Path: "41.78.16/base/layer0_files",
    tileSize: map.tileSize,
    width: map.width,
    height: map.height,
    maxLevel: map.maxLevel,
    // The deepest level the client should actually request — see
    // discoverRenderedMaxLevel's comment. This particular _b42Map shouldn't
    // ever predate the field post-fix, but if it somehow does (an old-shaped
    // cached response during a rolling restart), fail CLOSED to the same
    // known-safe floor discoverRenderedMaxLevel's own search starts from —
    // NOT map.maxLevel, which is exactly the inflated, never-actually-
    // rendered ceiling this whole fix exists to stop trusting.
    renderedMaxLevel: map.renderedMaxLevel ?? Math.max(0, map.maxLevel - 6),
    x0: map.x0,
    y0: map.y0,
    sqr: map.sqr,
    scale: map.scale,
  });
});

let persistedVehicleCache = { key: null, expiresAt: 0, vehicles: [] };

router.get("/vehicles", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer || activeServer.isRemote || !activeServer.zomboidDataPath) {
      return res.json({ vehicles: [] });
    }
    const serverName = activeServer.serverName || activeServer.name;
    if (!serverName) return res.json({ vehicles: [] });
    const savePath = path.join(activeServer.zomboidDataPath, "Saves", "Multiplayer", serverName);
    const cacheKey = `${savePath}`;
    if (persistedVehicleCache.key !== cacheKey || Date.now() >= persistedVehicleCache.expiresAt) {
      persistedVehicleCache = {
        key: cacheKey,
        expiresAt: Date.now() + 15000,
        vehicles: await listPersistedVehicles(savePath),
      };
    }
    res.json({ vehicles: persistedVehicleCache.vehicles });
  } catch (err) {
    log.warn(`Persisted vehicle lookup failed: ${err.message}`);
    res.json({ vehicles: [] });
  }
});

// Proxy DZI tiles from tiles.pzmap.org (migrated from pzmap.org, itself
// migrated from b42map.com) to avoid CORS restrictions. Resolves the latest
// B42 map directory dynamically from pzmap.org's build API (see the header
// comment) so new PZ map builds are picked up automatically.
// Validates inputs to prevent SSRF — only allows numeric level 0-22,
// floor -17..30, and tile filenames matching the DZI convention.
router.get("/tiles/:level/:tile", async (req, res) => {
  const level = parseInt(req.params.level, 10);
  const tile = req.params.tile;
  const floorRaw = Array.isArray(req.query.floor)
    ? req.query.floor[0]
    : req.query.floor;
  const floor = parseInt(String(floorRaw ?? "0"), 10);

  if (isNaN(level) || level < 0 || level > 22) {
    return res.status(400).json({ error: "Invalid level" });
  }
  // Client clamps floor to -17..29 (WorldMap.tsx changeFloor); keep the
  // backend in sync so anything outside the real range is rejected early.
  if (isNaN(floor) || floor < -17 || floor > 29) {
    return res.status(400).json({ error: "Invalid floor" });
  }
  // Every B42 layer DZI declares JPEG tiles, including basements and upper floors.
  const ext = "jpg";
  if (!new RegExp(`^\\d+_\\d+\\.${ext}$`).test(tile)) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const dir = await getB42Dir();
  const url = `${PZ_TILES_ROOT}/${dir}/base/layer${floor}_files/${level}/${tile}`;
  const contentType = "image/jpeg";
  const relPath = path.join("b42", dir, `layer${floor}`, String(level), tile);
  await serveTile(req, res, url, contentType, relPath);
});

// Proxy B42 top-down DZI tiles (used by ChunkCleaner for overhead map view).
// These tiles use webp format at all levels.
// Only floor 0 is available in the top-down view.
router.get("/toptiles/:level/:tile", async (req, res) => {
  const level = parseInt(req.params.level, 10);
  const tile = req.params.tile;

  if (isNaN(level) || level < 0 || level > 22) {
    return res.status(400).json({ error: "Invalid level" });
  }
  const parsed = /^(\d+_\d+)\.(webp|jpe?g|png)$/.exec(tile);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const dir = await getB42Dir();
  // The requested extension is ignored: the client cannot know which format a
  // given build was rendered in, so the upstream descriptor decides.
  const format = await getB42TopFormat(dir);
  const upstreamTile = `${parsed[1]}.${format}`;
  const url = `${PZ_TILES_ROOT}/${dir}/base_top/layer0_files/${level}/${upstreamTile}`;
  const relPath = path.join("b42-top", dir, String(level), upstreamTile);
  await serveTile(req, res, url, TOP_CONTENT_TYPES[format], relPath);
});

// Proxy B41 DZI tiles from tiles.pzmap.org.
router.get("/b41tiles/:level/:tile", async (req, res) => {
  const level = parseInt(req.params.level, 10);
  const tile = req.params.tile;

  if (isNaN(level) || level < 0 || level > 22) {
    return res.status(400).json({ error: "Invalid level" });
  }
  if (!/^\d+_\d+\.jpg$/.test(tile)) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const url = `${PZ_TILES_ROOT}/41.78.16/base/layer0_files/${level}/${tile}`;
  const relPath = path.join("b41", String(level), tile);
  await serveTile(req, res, url, "image/jpeg", relPath);
});

export default router;

// Exposed so the diagnostics route can probe the exact URLs this proxy would
// request, instead of a hardcoded build that may not be the one in use.
export { PZ_MAP_ROOT, PZ_TILES_ROOT, getB42Dir, getB42TopFormat, getB42ResolutionStatus };
