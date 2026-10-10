// Chunk-file rules shared by the Map Cleanup routes (routes/chunks.js):
//   - which file names a delete request may name, per source folder
//   - whether any chunk of a cell is still on disk
//   - the vehicles.db boxes that follow a chunk deletion
import fs from "fs";
import path from "path";

// B42: 1 cell = 32x32 chunks (256x256 tiles, 8 tiles/chunk).
// B41: 1 cell = 30x30 chunks (300x300 tiles, 10 tiles/chunk).
export function cellDivisorFor(isB42) {
  return isB42 ? 32 : 30;
}
export function tilesPerChunkFor(isB42) {
  return isB42 ? 8 : 10;
}

// The file names the scan in GET /chunks/:saveName emits, per source. A delete
// request names files relative to the source folder, so the names it may use
// are exactly these shapes and nothing else: `file` and `source` come from the
// client, and the delete joins them onto the save folder.
//   map       map/{X}/{Y}.bin (B42), or a flat name in map/ (B41)
//   saveroot  map_{X}_{Y}.bin in the save folder itself (B41)
//   chunkdata {X}_{Y}.bin in chunkdata/ (what the scan matches), also with the
//             game's own chunkdata_ prefix
const MAP_B42_FILE = /^(\d+)\/(\d+)\.bin$/;
const MAP_FLAT_FILE = /^(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i;
const SAVEROOT_FILE = /^map_(\d+)_(\d+)\.bin$/i;
const CHUNKDATA_FILE = /^(?:chunkdata_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i;

export const CHUNK_SOURCES = ["map", "saveroot", "chunkdata"];

/**
 * Check a delete request's chunk entry and read its coordinates from the file
 * name, which is the one thing about it that can't be wrong.
 *
 * @param {unknown} rawSource the entry's `source` (absent means map/)
 * @param {unknown} file the entry's `file`
 * @returns {{source: string, x?: number, y?: number, cellX?: number, cellY?: number} | {error: "source" | "file"}}
 *   x/y (chunk coordinates) for map and saveroot files, cellX/cellY for chunkdata.
 */
export function describeChunkFile(rawSource, file) {
  if (rawSource != null && !CHUNK_SOURCES.includes(rawSource)) {
    return { error: "source" };
  }
  // The scan only lists names ending in a lowercase ".bin".
  if (typeof file !== "string" || !file.endsWith(".bin")) return { error: "file" };
  const source = rawSource ?? "map";
  if (source === "chunkdata") {
    const m = CHUNKDATA_FILE.exec(file);
    if (!m) return { error: "file" };
    return { source, cellX: parseInt(m[1], 10), cellY: parseInt(m[2], 10) };
  }
  const m =
    source === "saveroot"
      ? SAVEROOT_FILE.exec(file)
      : (MAP_B42_FILE.exec(file) ?? MAP_FLAT_FILE.exec(file));
  if (!m) return { error: "file" };
  return { source, x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

// B42: is any map/{X}/{Y}.bin of the cell on disk? A directory that can't be
// read counts as yes, to stay safe.
async function b42CellHasChunks(savePath, cellX, cellY, divisor) {
  const mapPath = path.join(savePath, "map");
  const minChunkX = cellX * divisor;
  const maxChunkX = minChunkX + divisor - 1;
  const minChunkY = cellY * divisor;
  const maxChunkY = minChunkY + divisor - 1;
  for (let cx = minChunkX; cx <= maxChunkX; cx++) {
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(mapPath, String(cx)));
    } catch (e) {
      if (e.code === "ENOENT") continue;
      return true;
    }
    for (const name of entries) {
      const m = name.match(/^(\d+)\.bin$/);
      if (!m) continue;
      const y = parseInt(m[1], 10);
      if (y >= minChunkY && y <= maxChunkY) return true;
    }
  }
  return false;
}

// B41: every flat chunk file (map/ and the save folder), read once.
async function readB41Chunks(savePath) {
  const found = [];
  const folders = [
    [path.join(savePath, "map"), MAP_FLAT_FILE],
    [savePath, SAVEROOT_FILE],
  ];
  for (const [dir, pattern] of folders) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      return null;
    }
    for (const name of entries) {
      const m = pattern.exec(name);
      if (m) found.push({ x: parseInt(m[1], 10), y: parseInt(m[2], 10) });
    }
  }
  return found;
}

/**
 * Returns `async (cellX, cellY) => boolean`: is any chunk file of that cell
 * still on disk? Answers are remembered, so ask after the deletes. Unreadable
 * folders answer yes, to stay safe.
 */
export function createCellSurvivorCheck(savePath, isB42) {
  const divisor = cellDivisorFor(isB42);
  const answers = new Map();
  let b41Chunks = null;
  return (cellX, cellY) => {
    const key = `${cellX},${cellY}`;
    if (!answers.has(key)) {
      answers.set(
        key,
        (async () => {
          if (isB42) return b42CellHasChunks(savePath, cellX, cellY, divisor);
          b41Chunks ??= readB41Chunks(savePath);
          const chunks = await b41Chunks;
          if (chunks === null) return true;
          const minX = cellX * divisor;
          const minY = cellY * divisor;
          return chunks.some(
            (c) =>
              c.x >= minX && c.x < minX + divisor && c.y >= minY && c.y < minY + divisor,
          );
        })(),
      );
    }
    return answers.get(key);
  };
}

/**
 * The vehicles.db boxes for chunks that were just deleted. Call after the
 * deletes. Each chunk gets its own box. A chunkdata entry stands for its whole
 * cell, so it gets the cell's box, but only when no chunk of that cell is left:
 * the scan positions it at the cell's top-left chunk, so a selection that only
 * covers that corner would otherwise wipe the vehicles of every other chunk in
 * the cell.
 *
 * Also supplies wx/wy (chunk-coord) bounds so vehicles with drifted tile
 * coords but valid chunk coords still get matched.
 *
 * @param {string} savePath
 * @param {Array<{source?: string, x?: number, y?: number, cellX?: number, cellY?: number}>} chunks
 * @param {boolean} isB42
 */
export async function buildVehicleBoxes(savePath, chunks, isB42) {
  const cellDivisor = cellDivisorFor(isB42);
  const tilesPerChunk = tilesPerChunkFor(isB42);
  const cellTileSpan = cellDivisor * tilesPerChunk;
  const cellHasChunks = createCellSurvivorCheck(savePath, isB42);
  const boxes = [];
  for (const c of chunks) {
    if (c.source === "chunkdata") {
      if (c.cellX == null || c.cellY == null) continue;
      if (await cellHasChunks(c.cellX, c.cellY)) continue;
      const x0 = c.cellX * cellTileSpan;
      const y0 = c.cellY * cellTileSpan;
      const wx0 = c.cellX * cellDivisor;
      const wy0 = c.cellY * cellDivisor;
      boxes.push({
        x0,
        x1: x0 + cellTileSpan,
        y0,
        y1: y0 + cellTileSpan,
        wx0,
        wx1: wx0 + cellDivisor,
        wy0,
        wy1: wy0 + cellDivisor,
      });
      continue;
    }
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const x0 = c.x * tilesPerChunk;
    const y0 = c.y * tilesPerChunk;
    boxes.push({
      x0,
      x1: x0 + tilesPerChunk,
      y0,
      y1: y0 + tilesPerChunk,
      wx0: c.x,
      wx1: c.x + 1,
      wy0: c.y,
      wy1: c.y + 1,
    });
  }
  return boxes;
}
