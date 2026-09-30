// Hourly Trash retention for local Server Files roots (spec §A6.6): every
// Trash item older than TRASH_RETENTION_DAYS is deleted for good, one pass
// per distinct folder (roots shared by several profiles are visited once,
// by installDirKey). Remote roots expire lazily, when their Trash is listed
// or written. Each root that lost items gets one files.trash.expire audit
// row with actor "system".
import { getServers, getAllSettings } from "../database/init.js";
import { createLogger } from "../utils/logger.js";
import { describeProfileRoots, isRemoteProfile } from "./fileManagerRoots.js";
import { expiredTrashIds, purgeTrashItem } from "./fileManagerTrash.js";
import { SYSTEM_ACTOR, writeAudit } from "./fileManagerAudit.js";
import { FM_LIMITS } from "./fileManagerContract.js";

const log = createLogger("FileManager:Janitor");

const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

let timer = null;
let firstTimer = null;
let running = false;

/**
 * One retention pass. Exported for tests; `now` lets them age items without
 * waiting a week.
 * @returns {Promise<{ roots: number, expired: number }>}
 */
export async function runFileManagerJanitor({ now = Date.now() } = {}) {
  if (running) return { roots: 0, expired: 0 };
  running = true;
  let roots = 0;
  let expired = 0;
  try {
    const [profiles, settings] = await Promise.all([getServers(), getAllSettings()]);
    const seen = new Set();
    for (const profile of profiles || []) {
      if (isRemoteProfile(profile)) continue;
      let info;
      try {
        info = await describeProfileRoots(profile, settings || {}, { fresh: true });
      } catch {
        continue;
      }
      for (const root of info.roots.values()) {
        if (!root.available || !root.real || root.kind !== "local") continue;
        const key = root.key || root.real;
        if (seen.has(key)) continue;
        seen.add(key);
        roots++;
        const ids = expiredTrashIds(root.real, now);
        const removed = [];
        for (const trashId of ids) {
          try {
            purgeTrashItem(root.real, trashId, { maxEntries: FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES });
            removed.push(trashId);
          } catch (err) {
            log.warn(`Could not expire a Trash item in a ${root.id} folder: ${err?.code || err?.name || "error"}`);
          }
        }
        if (removed.length) {
          expired += removed.length;
          await writeAudit({
            actor: SYSTEM_ACTOR,
            profileId: String(profile.id),
            profileName: profile.name || profile.serverName || null,
            backend: root.backend,
            rootId: root.id,
            op: "files.trash.expire",
            paths: [],
            trashIds: removed,
            result: "ok",
          });
        }
      }
    }
  } catch (err) {
    log.warn(`Trash retention pass failed: ${err?.code || err?.name || "error"}`);
  } finally {
    running = false;
  }
  return { roots, expired };
}

export function startFileManagerJanitor() {
  if (timer) return;
  firstTimer = setTimeout(() => {
    runFileManagerJanitor().catch(() => {});
  }, FIRST_RUN_DELAY_MS);
  firstTimer.unref?.();
  timer = setInterval(() => {
    runFileManagerJanitor().catch(() => {});
  }, INTERVAL_MS);
  timer.unref?.();
}

export function stopFileManagerJanitor() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}
