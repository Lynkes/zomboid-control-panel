// Per-path locks for Server Files writes. withFileLocks() takes the panel's
// shared per-file lock (utils/fileWriteQueue.js's withFileLock, the one the
// raw config editor and the mods tool take) for every key, in sorted order,
// so two requests that need the same pair of paths can't deadlock, and a
// file-manager save can't interleave with a raw-editor save of the same
// file. Keys are absolute paths: the path as the profile spells it (the
// "lexical" key) and its real path, so a save through a link and a save by
// the real name still serialize.
import path from "path";
import { withFileLock } from "../utils/fileWriteQueue.js";

function normalizeKeys(keys) {
  const unique = new Set();
  for (const key of keys) {
    if (typeof key === "string" && key) unique.add(path.resolve(key));
  }
  return [...unique].sort();
}

/**
 * Run `fn` holding every lock in `keys` (sorted, deduplicated).
 * @template T
 * @param {string[]} keys
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withFileLocks(keys, fn) {
  const sorted = normalizeKeys(keys);
  const run = (index) => {
    if (index >= sorted.length) return Promise.resolve().then(fn);
    return withFileLock(sorted[index], () => run(index + 1));
  };
  return run(0);
}
