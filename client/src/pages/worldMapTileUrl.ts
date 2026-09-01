// hunt-wave12-2026-08-30 (version-the-tile-url-by-resolved-b42-build):
// mapProxy.js's browser-facing tile URL used to carry no identifier for
// WHICH resolved B42 build produced its bytes, so a long browser
// Cache-Control risked serving an old build's tile under a URL a new build
// now answers differently -- see mapProxy.js's TILE_BROWSER_CACHE_CONTROL
// comment for the full history. The fix: name the resolved build in the
// URL itself (`?v=<dir>`) so two different builds are two different URLs,
// and mapProxy.js can safely cache a versioned request indefinitely. This
// is the pure query-string half of that, pulled out so it's unit-testable
// without mounting the canvas -- same reasoning as worldMapTileFallback.ts.

// `floor` is a query param on THIS proxy route specifically (not a path
// segment -- see buildDirectTileUrl's own comment in WorldMap.tsx), and
// only ever included when non-default (matches the pre-existing
// behaviour, unrelated to this change). `versionDir` is the resolved B42
// build directory, or null when it isn't known yet (before /api/map/resolve
// completes) or doesn't apply (B41, whose upstream directory is a fixed
// literal, never dynamically resolved -- nothing to version).
export function buildTileQuery(floor: number, versionDir: string | null): string {
  const floorParam = floor !== 0 ? `floor=${floor}` : "";
  const versionParam = versionDir ? `v=${encodeURIComponent(versionDir)}` : "";
  const params = [floorParam, versionParam].filter(Boolean).join("&");
  return params ? `?${params}` : "";
}
