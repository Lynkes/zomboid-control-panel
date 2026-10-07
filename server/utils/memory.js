/**
 * Shared memory-value normalizer.
 *
 * Server configs sometimes accumulate `minMemory`/`maxMemory` values stored
 * in MB instead of GB (older UI versions, hand-edited configs, imports).
 * This heuristically converts anything that looks like MB back to GB.
 *
 * NOTE: this used to be duplicated in `database/init.js` and `routes/server.js`
 * with DIFFERENT thresholds (2048 vs 128), so the same stored value could
 * normalize to two different numbers depending on which code path read it —
 * producing inconsistent JVM -Xmx/-Xms between what's saved and what's
 * written into the server's start script. Both now import this single
 * implementation. 128 was chosen as the shared threshold: real-world PZ
 * servers essentially never allocate more than ~128GB, so any value above
 * that is assumed to be MB and converted down.
 */
export function normalizeMemoryGb(value, fallback) {
  const textValue = typeof value === "string" ? value.trim() : null;
  const parsed =
    typeof value === "number"
      ? value
      : textValue && /^\+?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  if (parsed > 128) {
    return Math.max(1, Math.round(parsed / 1024));
  }
  return parsed;
}

/**
 * A server's minimum memory, where 0 is a value of its own: no -Xms at all,
 * so the JVM picks a small initial heap and ZGC can hand back everything the
 * server isn't using (it never uncommits below -Xms). Anything else is read
 * like normalizeMemoryGb() -- which turns 0 into `fallback`, so a 0 saved
 * through it used to come back as a 4 GB minimum.
 */
export function normalizeMinMemoryGb(value, fallback) {
  if (value === 0 || (typeof value === "string" && /^\+?0+$/.test(value.trim()))) {
    return 0;
  }
  return normalizeMemoryGb(value, fallback);
}
