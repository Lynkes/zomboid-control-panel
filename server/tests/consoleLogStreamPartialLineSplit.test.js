import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt round 13 (log tail truth): GET /console-log/stream is
// the endpoint the Console page actually long-polls (server/services/
// logTailer.js is a completely separate reader used only for chat/death
// parsing -- it never feeds the Console page). It used to split whatever
// bytes a poll happened to read on "\n" with no memory of a trailing
// fragment: a poll landing exactly between two writes to the SAME line (PZ
// hasn't finished writing it yet) emitted that half-written line as if it
// were complete, then the REST of the same line reappeared as its own
// garbled fragment on the next poll once the write finished -- "partial
// lines split across reads". Fixed by holding the trailing incomplete
// segment back in a small bounded map keyed to the exact (path, byte
// offset) it was captured at, and reattaching it to whichever poll
// resumes from that same offset -- mirroring LogTailer's own established
// _splitLines()/remainder pattern, but as a map rather than a single slot
// so multiple interleaved pollers at different offsets don't clobber each
// other's pending fragment (round 13b).

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

describe("GET /console-log/stream: partial lines are not split across polls", () => {
  let dataDir;
  let consoleLogPath;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-console-stream-"));
    consoleLogPath = path.join(dataDir, "server-console.txt");
    getSettingMock.mockReset().mockResolvedValue(null);
    getActiveServerMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("holds back a mid-line poll and reassembles the full line once the write finishes", async () => {
    // First poll: server has already written one complete line and is
    // mid-way through writing a second one (no trailing newline yet) --
    // exactly what a poll landing between two writes looks like on disk.
    fs.writeFileSync(consoleLogPath, "LOG STARTED\nPartial line still bei");

    const first = await poll(dataDir, 0);
    expect(first.newLines).toEqual(["LOG STARTED"]);
    // currentSize must still reflect the TRUE file size read (not just the
    // complete-line boundary) -- the client's next poll resumes from here.
    const sizeAfterFirst = Buffer.byteLength(
      "LOG STARTED\nPartial line still bei",
      "utf-8",
    );
    expect(first.currentSize).toBe(sizeAfterFirst);

    // The write finishes: the rest of that same line, plus a new one.
    fs.appendFileSync(consoleLogPath, "ng written\nAnother complete line\n");

    const second = await poll(dataDir, first.currentSize);
    // Reassembled as ONE real line, not two garbled fragments.
    expect(second.newLines).toEqual([
      "Partial line still being written",
      "Another complete line",
    ]);
  });

  it("a poll that resumes from a DIFFERENT offset than where the remainder was captured does not get a stale fragment glued onto it (no cross-contamination between pollers)", async () => {
    fs.writeFileSync(consoleLogPath, "LOG STARTED\nPartial line still bei");
    const first = await poll(dataDir, 0);
    expect(first.newLines).toEqual(["LOG STARTED"]);

    fs.appendFileSync(consoleLogPath, "ng written\n");

    // A second, independent poller that never saw the first poll's result
    // and is still asking from byte 0 -- must get the whole file cleanly,
    // not the first poller's held-back fragment prepended to it.
    const independent = await poll(dataDir, 0);
    expect(independent.newLines).toEqual([
      "LOG STARTED",
      "Partial line still being written",
    ]);
  });

  // round 13b (god-caught follow-up): the original fix used a single
  // module-level slot. With two genuinely interleaved pollers at different
  // offsets, viewer B's poll would overwrite the ONE slot before viewer A
  // ever got a chance to retrieve its own held-back fragment -- losing the
  // START of A's line entirely (worse than no buffering at all, which at
  // least showed the fragment as a premature line rather than dropping it).
  // Replaced with a bounded map keyed by (path, resumeAtSize) so each
  // poller's fragment waits independently for its own matching next poll.
  it("two interleaved pollers at different offsets each get their own line reassembled (a single shared slot used to lose one entirely)", async () => {
    // Viewer A polls first, mid-line.
    fs.writeFileSync(consoleLogPath, "LOG STARTED\nA-fragment-in-progr");
    const aFirst = await poll(dataDir, 0);
    expect(aFirst.newLines).toEqual(["LOG STARTED"]);
    const aResumeAt = aFirst.currentSize;

    // The write finishes A's line and starts a second, unrelated partial line.
    fs.appendFileSync(consoleLogPath, "ess\nB-fragment-in-progr");

    // Viewer B opens a fresh tab and polls from scratch -- lands mid-line
    // too, but at a DIFFERENT resulting offset than A's still-pending
    // fragment. Under the old single-slot bug, capturing B's fragment here
    // would silently discard A's.
    const bFirst = await poll(dataDir, 0);
    expect(bFirst.newLines).toEqual(["LOG STARTED", "A-fragment-in-progress"]);
    const bResumeAt = bFirst.currentSize;
    expect(bResumeAt).not.toBe(aResumeAt);

    // Viewer A's second poll, resuming from ITS OWN earlier offset -- must
    // still get its fragment back, undisturbed by viewer B's poll in between.
    const aSecond = await poll(dataDir, aResumeAt);
    expect(aSecond.newLines).toEqual(["A-fragment-in-progress"]);
  });
});
