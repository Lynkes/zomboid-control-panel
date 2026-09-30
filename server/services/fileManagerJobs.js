// Background jobs for Server Files: permanent delete and Trash purge
// (spec §A6.6). A job runs in-process, reports progress, and is kept for
// JOB_TTL_AFTER_DONE_MS after it finishes; only its owner can read it. While
// it runs it "holds" its paths, so another mutation touching them is
// refused with FM_OPERATION_IN_PROGRESS {operation:"fileJob"}.
import crypto from "crypto";
import { ErrorCode } from "../utils/errorCodes.js";
import { createLogger } from "../utils/logger.js";
import { FM_LIMITS, FmError } from "./fileManagerContract.js";
import { relWithin } from "./fileManagerProtectedAreas.js";

const log = createLogger("FileManager:Jobs");

export const JOB_ID_RE = /^[0-9a-f]{32}$/;

/**
 * @type {Map<string, { id: string, ownerUserId: string|null, kind: string, state: string,
 *   progress: { done: number, total: number|null }, error?: { code: string, params?: object },
 *   holds: Array<{ rootKey: string, realRel: string }>, finishedAt?: number }>}
 */
const jobs = new Map();

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > FM_LIMITS.JOB_TTL_AFTER_DONE_MS) jobs.delete(id);
  }
}

export function _resetJobsForTests() {
  jobs.clear();
}

/**
 * Start a job. `run(onProgress)` does the work; it may throw an FmError.
 * @returns {string} jobId
 */
export function startJob({ ownerUserId, kind, holds = [], total = null }, run) {
  sweep();
  const id = crypto.randomBytes(16).toString("hex");
  const job = {
    id,
    ownerUserId: ownerUserId ?? null,
    kind,
    state: "running",
    progress: { done: 0, total },
    holds,
  };
  jobs.set(id, job);
  const onProgress = (done, jobTotal) => {
    job.progress.done = done;
    if (jobTotal !== undefined && jobTotal !== null) job.progress.total = jobTotal;
  };
  // Detached on purpose: the request answers 202 with the id at once.
  Promise.resolve()
    .then(() => run(onProgress))
    .then(
      () => {
        job.state = "done";
      },
      (err) => {
        job.state = "failed";
        job.error =
          err instanceof FmError
            ? { code: err.code, ...(err.params && Object.keys(err.params).length ? { params: err.params } : {}) }
            : { code: ErrorCode.FM_INTERNAL };
        if (!(err instanceof FmError)) log.warn(`File job ${kind} failed: ${err?.code || err?.name || "error"}`);
      },
    )
    .finally(() => {
      job.finishedAt = Date.now();
      job.holds = [];
      const timer = setTimeout(() => sweep(), FM_LIMITS.JOB_TTL_AFTER_DONE_MS + 1000);
      timer.unref?.();
    });
  return id;
}

/** The job as its owner sees it; anyone else gets FM_JOB_NOT_FOUND. */
export function getJob(jobId, userId) {
  sweep();
  const job = typeof jobId === "string" && JOB_ID_RE.test(jobId) ? jobs.get(jobId) : null;
  if (!job || job.ownerUserId === null || job.ownerUserId !== (userId ?? null)) {
    throw new FmError(ErrorCode.FM_JOB_NOT_FOUND);
  }
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    progress: { done: job.progress.done, total: job.progress.total },
    ...(job.error ? { error: job.error } : {}),
  };
}

/** Wait for a job to finish (tests). */
export async function _waitForJobForTests(jobId, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const job = jobs.get(jobId);
    if (!job || job.state !== "running") return job;
    if (Date.now() - started > timeoutMs) throw new Error("job timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * True when a running job holds `realRel` in the root with `rootKey`, or an
 * ancestor or descendant of it.
 */
export function isHeldByJob(rootKey, realRel) {
  for (const job of jobs.values()) {
    if (job.state !== "running") continue;
    for (const hold of job.holds) {
      if (hold.rootKey !== rootKey) continue;
      if (relWithin(hold.realRel, realRel) || relWithin(realRel, hold.realRel)) return true;
    }
  }
  return false;
}
