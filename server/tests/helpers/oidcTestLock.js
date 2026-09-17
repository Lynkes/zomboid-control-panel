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
        const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        if (age > LOCK_STALE_MS) fs.unlinkSync(LOCK_PATH);
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}