import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt round 14 (console stream file identity, follow-up to
// round 13): GET /console-log/stream used to detect a rotation ONLY via
// `stats.size < lastSize` -- a shrink. PZ recreating server-console.txt on
// restart (or the active server switching to a different server's own
// consoleLogPath) produces a brand-new file that starts at 0 and can grow
// PAST the client's old lastSize within a single poll window before
// anyone notices, so the size-only check silently read the wrong byte
// range of the NEW file, permanently skipping its own early content.
// Fixed with a server-side per-path identity check (inode, falling back
// to birthtime) -- see consoleLogIdentityChanged()'s own comment for why
// this was chosen over a client-echoed token.

const getSettingMock = vi.fn(async () => null);
const getActiveServerMock = vi.fn(async () => null);

vi.mock("../database/init.js", () => ({
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: (...args) => getActiveServerMock(...args),
  getRoleByName: vi.fn(async () => null),
}));

const { default: router } = await import("../routes/server.js");

function getStreamHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/console-log/stream" && entry.route.methods.get,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function poll(zomboidDataPath, lastSize) {
  const handler = getStreamHandler();
  const req = { query: { lastSize: String(lastSize) } };
  const res = createResponse();
  getActiveServerMock.mockResolvedValueOnce({ zomboidDataPath });
  await handler(req, res);
  expect(res.json).toHaveBeenCalledTimes(1);
  return res.json.mock.calls[0][0];
}

// Deletes and recreates the file at the same path -- a genuinely NEW
// inode/file record, matching what a real PZ restart (or any tool that
// deletes and rewrites the log rather than truncating it in place) does.
// A plain fs.writeFileSync() over an existing path truncates in place
// (same inode) and would not reproduce the bug this file tests.
function recreateFile(filePath, content) {
  fs.unlinkSync(filePath);
  fs.writeFileSync(filePath, content);
}

describe("GET /console-log/stream: file identity survives a same-path recreate", () => {
  let dataDir;
  let consoleLogPath;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-console-identity-"));
    consoleLogPath = path.join(dataDir, "server-console.txt");
    getSettingMock.mockReset().mockResolvedValue(null);
    getActiveServerMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("treats a same-path recreate that is already LARGER than lastSize as a rotation, not silent growth", async () => {
    fs.writeFileSync(consoleLogPath, "Old session line 1\nOld session line 2\n");
    const first = await poll(dataDir, 0);
    expect(first.newLines).toEqual([
      "Old session line 1",
      "Old session line 2",
    ]);
    const oldLastSize = first.currentSize;

    // PZ "restarts": the console log is deleted and a brand-new file is
    // written in its place, and by the time the panel polls again that
    // new file has ALREADY grown past the old file's last known size --
    // the exact race a size-only check cannot see.
    const newSessionContent =
      "New session line A\nNew session line B\nNew session line C\n";
    expect(Buffer.byteLength(newSessionContent, "utf-8")).toBeGreaterThan(
      oldLastSize,
    );
    recreateFile(consoleLogPath, newSessionContent);

    const second = await poll(dataDir, oldLastSize);
    expect(second.rotated).toBe(true);
    // The WHOLE new file, not a byte-range skip into the middle of it.
    expect(second.newLines).toEqual([
      "New session line A",
      "New session line B",
      "New session line C",
    ]);
  });

  it("still behaves as a normal incremental read once identity is established and the SAME file just grows (no false rotation)", async () => {
    fs.writeFileSync(consoleLogPath, "Line 1\n");
    // This first poll is this process's first-ever look at this exact path,
    // so it establishes the identity baseline (and is itself correctly
    // reported as rotated:true -- a one-time, harmless full read, not the
    // thing this test is checking; see consoleLogIdentityChanged's comment).
    const first = await poll(dataDir, 0);
    expect(first.newLines).toEqual(["Line 1"]);

    // The real assertion: now that a baseline exists, ordinary growth of
    // the SAME file must NOT be misclassified as a rotation.
    fs.appendFileSync(consoleLogPath, "Line 2\n");
    const second = await poll(dataDir, first.currentSize);
    expect(second.rotated).toBeFalsy();
    expect(second.newLines).toEqual(["Line 2"]);
  });

  it("treats an active-server switch (a different consoleLogPath) the same way -- no stale lastSize misreads the new server's file", async () => {
    const serverADir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-console-identity-a-"));
    const serverBDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-console-identity-b-"));
    try {
      const pathA = path.join(serverADir, "server-console.txt");
      const pathB = path.join(serverBDir, "server-console.txt");
      fs.writeFileSync(pathA, "Server A line 1\nServer A line 2\n");
      const firstA = await poll(serverADir, 0);
      expect(firstA.newLines).toEqual(["Server A line 1", "Server A line 2"]);
      const staleLastSize = firstA.currentSize;

      // Server B's own console log already exceeds server A's last known
      // size -- a stale lastSize carried over from A must not cause a
      // byte-range read into the middle of B's unrelated file.
      const serverBContent =
        "Server B line 1\nServer B line 2\nServer B line 3\n";
      expect(Buffer.byteLength(serverBContent, "utf-8")).toBeGreaterThan(
        staleLastSize,
      );
      fs.writeFileSync(pathB, serverBContent);

      const switched = await poll(serverBDir, staleLastSize);
      expect(switched.rotated).toBe(true);
      expect(switched.newLines).toEqual([
        "Server B line 1",
        "Server B line 2",
        "Server B line 3",
      ]);
    } finally {
      fs.rmSync(serverADir, { recursive: true, force: true });
      fs.rmSync(serverBDir, { recursive: true, force: true });
    }
  });
});
