import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// Security sweep 2026-10-04, adversary pass on DISKFILL: the bounded tile
// cache builds its index from what is on disk the first time a tile is
// served, then trims it to the budget. Every tile write waited for that
// whole load -- including the trim's one-at-a-time deletes -- while holding
// its tile buffer. On the first boot after an upgrade with a large cache
// left by the old unbounded version, every anonymous tile miss during that
// window held about 1 MB in memory until it ended (106 MiB for 61 misses in
// the adversary's 2.3 s run; tens of seconds for a 100k+ file cache).
//
// Fix: the trim runs in the background once the index is built, and at most
// MAX_WRITES_WAITING_FOR_INDEX (16) writes wait for the scan; later ones
// serve the tile without keeping it.

const { getDataPaths } = await import("../utils/paths.js");
const TILES = path.join(getDataPaths().dataDir, "map-tiles-cache");

// A cache an older version left behind, well past the test budget. Must
// exist before the first write triggers the scan.
const RESIDUE = 1500;
for (let d = 0; d < RESIDUE / 100; d++) {
  const dir = path.join(TILES, "b41", "15", `x${d}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `${i}_0.jpg`), "x");
}

const mapProxy = await import("../routes/mapProxy.js");
mapProxy._setTileCacheLimitsForTests({ diskMaxFiles: 10 });

afterAll(() => {
  vi.restoreAllMocks();
});

function tileFiles() {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(TILES);
  return files;
}

describe("tile writes during the one-time cache scan are bounded", () => {
  it("only a few writes wait for the scan, each holding its tile; the rest are served uncached", async () => {
    const tmpWrites = vi.spyOn(fs.promises, "writeFile");
    const tile = Buffer.alloc(64 * 1024, 0x41);

    // 50 distinct misses before the scan of 1500 files can finish.
    const writes = [];
    for (let i = 0; i < 50; i++) {
      writes.push(mapProxy.writeDiskCacheAsync(path.join("b41", "16", `${i}_0.jpg`), tile));
    }
    await Promise.all(writes);

    const tileWrites = tmpWrites.mock.calls.filter(([target]) => String(target).endsWith(".tmp"));
    expect(tileWrites.length).toBeLessThanOrEqual(16);
    expect(tileWrites.length).toBeGreaterThan(0);

    // The trim still brings the cache back within budget.
    const deadline = Date.now() + 30000;
    while (tileFiles().length > 10 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(tileFiles().length).toBeLessThanOrEqual(10);

    // Once the index is built, a write goes straight to disk.
    await mapProxy.writeDiskCacheAsync(path.join("b41", "16", "after_0.jpg"), tile);
    expect(fs.existsSync(path.join(TILES, "b41", "16", "after_0.jpg"))).toBe(true);
  });
});
