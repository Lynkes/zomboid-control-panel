import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { getDataPaths } from "../utils/paths.js";

// Defence in depth (CodeQL js/path-injection on the 2026-10-04 security
// sweep's PR): the map tile cache and the player export routes build their
// paths from values that are regex-checked elsewhere, so nothing can leave
// their folders today. Each now also resolves the path and refuses one
// outside its folder right where it is used, so that stays true if a caller
// or a rule ever changes.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("map tile disk cache: a path outside the cache folder is never written", () => {
  it("drops the write instead of creating the file", async () => {
    const { writeDiskCacheAsync } = await import("../routes/mapProxy.js");
    const cacheDir = path.join(getDataPaths().dataDir, "map-tiles-cache");
    const escaped = path.resolve(cacheDir, "..", "escaped-tile.jpg");
    const writes = [];
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation((filePath, data) => {
      writes.push(String(filePath));
      return realWriteFile(filePath, data);
    });

    await writeDiskCacheAsync("../escaped-tile.jpg", Buffer.from("x"));

    expect(writes).toEqual([]);
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it("still writes a normal tile inside the cache folder", async () => {
    const { writeDiskCacheAsync } = await import("../routes/mapProxy.js");
    const cacheDir = path.join(getDataPaths().dataDir, "map-tiles-cache");
    await writeDiskCacheAsync("20/0/4_5.jpg", Buffer.from("tile"));
    expect(fs.readFileSync(path.join(cacheDir, "20", "0", "4_5.jpg"), "utf8")).toBe("tile");
  });
});
