import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 120000;
const LOCK_PATH = path.join(
  os.tmpdir(),
  `zcp-oidc-test-${crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}.lock`,
);

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireOidcTestLock() {
  // Vitest can place these files in separate worker processes. A global
  // promise only serialized files sharing one worker, while each file mutates
  // process.env and the OIDC discovery cache. Use an atomic temp-file lock so
  // the isolation holds across workers too.
  while (true) {
    try {
      const handle = fs.openSync(LOCK_PATH, "wx");
      fs.writeFileSync(handle, `${process.pid}\n${Date.now()}\n`, "utf8");
      fs.closeSync(handle);
      return () => {
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      try {
        const [pidText, createdAtText] = fs.readFileSync(LOCK_PATH, "utf8").trim().split(/\s+/);
        const pid = Number(pidText);
        const createdAt = Number(createdAtText);
        const age = Date.now() - createdAt;
        // A live worker may legitimately hold this lock while the rest of the
        // suite is consuming CPU. Never use elapsed time alone to steal it.
        // The age fallback only handles a crashed worker whose PID no longer
        // exists, or a truncated lock file with no usable owner metadata.
        if (!isProcessAlive(pid) && (!Number.isFinite(createdAt) || age > LOCK_STALE_MS)) {
          fs.unlinkSync(LOCK_PATH);
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        if (statError?.code === "EPERM") continue;
        const age = (() => {
          try {
            return Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
          } catch {
            return 0;
          }
        })();
        if (age > LOCK_STALE_MS) fs.unlinkSync(LOCK_PATH);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}