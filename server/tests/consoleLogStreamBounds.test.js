import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Console audit (2026-10-12), GET /console-log/stream:
//  - the first stream poll of a path in a panel process counted as "identity
//    unknown", answered rotated:true and read the WHOLE file, so every page
//    load after a panel start shipped the entire server-console.txt (hundreds
//    of MB on a long-running server) to a pane that keeps 500 lines. The
//    GET /console-log the page makes first now seeds the identity, and both
//    reads are capped to the last 256 KB with `truncated: true`;
//  - the identity record is shared, so only the first of several open pages
//    was told the log had been recreated. A page now echoes the `identity`
//    token it was given and is judged against that.

const getSettingMock = vi.fn(async () => null);
const getActiveServerMock = vi.fn(async () => null);

vi.mock("../database/init.js", () => ({
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: (...args) => getActiveServerMock(...args),
  getRoleByName: vi.fn(async () => null),
}));

const { default: router } = await import("../routes/server.js");

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.get,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function call(routePath, zomboidDataPath, query) {
  const handler = getHandler(routePath);
  const res = createResponse();
  getActiveServerMock.mockResolvedValueOnce({ zomboidDataPath });
  await handler({ query }, res);
  expect(res.json).toHaveBeenCalledTimes(1);
  return res.json.mock.calls[0][0];
}

const loadLog = (dir) => call("/console-log", dir, { filter: "all" });
const poll = (dir, lastSize, identity) =>
  call("/console-log/stream", dir, {
    filter: "all",
    lastSize: String(lastSize),
    ...(identity === undefined ? {} : { identity }),
  });

function numberedLines(count, from = 0) {
  let text = "";
  for (let i = from; i < from + count; i += 1) {
    text += `line ${String(i).padStart(7, "0")} ${"x".repeat(60)}\n`;
  }
  return text;
}

describe("GET /console-log/stream: bounded reads and per-page rotation", () => {
  let dataDir;
  let consoleLogPath;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-console-bounds-"));
    consoleLogPath = path.join(dataDir, "server-console.txt");
    getSettingMock.mockReset().mockResolvedValue(null);
    getActiveServerMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("the stream poll right after GET /console-log is an ordinary read, not a rotation of the whole file", async () => {
    fs.writeFileSync(consoleLogPath, numberedLines(50));
    const loaded = await loadLog(dataDir);
    expect(loaded.exists).toBe(true);
    expect(typeof loaded.identity).toBe("string");

    const idle = await poll(dataDir, loaded.size);
    expect(idle.rotated).toBeFalsy();
    expect(idle.newLines).toEqual([]);

    fs.appendFileSync(consoleLogPath, "after the page loaded\n");
    const next = await poll(dataDir, idle.currentSize);
    expect(next.rotated).toBeFalsy();
    expect(next.newLines).toEqual(["after the page loaded"]);
  });

  it("a rotation (here: a path the process never saw) answers with the last 256 KB only, and says so", async () => {
    fs.writeFileSync(consoleLogPath, numberedLines(12000)); // about 800 KB
    const size = fs.statSync(consoleLogPath).size;
    expect(size).toBeGreaterThan(512 * 1024);

    const answer = await poll(dataDir, 0);

    expect(answer.rotated).toBe(true);
    expect(answer.truncated).toBe(true);
    expect(answer.currentSize).toBe(size);
    expect(answer.newLines.at(-1)).toMatch(/^line 0011999 /);
    expect(answer.newLines[0]).not.toMatch(/^line 0000000 /);
    const bytes = answer.newLines.reduce((total, line) => total + line.length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
    expect(bytes).toBeGreaterThan(200 * 1024);
    // the first line is dropped whole, never delivered cut in half
    for (const line of answer.newLines) expect(line).toMatch(/^line \d{7} x{60}$/);
  });

  it("a small log is still delivered whole, untruncated", async () => {
    fs.writeFileSync(consoleLogPath, numberedLines(20));
    const answer = await poll(dataDir, 0);
    expect(answer.rotated).toBe(true);
    expect(answer.truncated).toBeUndefined();
    expect(answer.newLines).toHaveLength(20);
  });

  it("a page far behind gets the last 256 KB of what it missed, flagged truncated, not a rotation", async () => {
    fs.writeFileSync(consoleLogPath, numberedLines(10));
    const loaded = await loadLog(dataDir);

    fs.appendFileSync(consoleLogPath, numberedLines(12000, 10));
    const answer = await poll(dataDir, loaded.size, loaded.identity);

    expect(answer.rotated).toBeFalsy();
    expect(answer.truncated).toBe(true);
    expect(answer.newLines.at(-1)).toMatch(/^line 0012009 /);
    const bytes = answer.newLines.reduce((total, line) => total + line.length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
    for (const line of answer.newLines) expect(line).toMatch(/^line \d{7} x{60}$/);
  });

  it("hands back the identity token with every answer", async () => {
    fs.writeFileSync(consoleLogPath, "one\n");
    const first = await poll(dataDir, 0);
    const idle = await poll(dataDir, first.currentSize, first.identity);
    expect(typeof first.identity).toBe("string");
    expect(idle.identity).toBe(first.identity);
  });

  it("every open page is told about a recreated log, not just the first to poll", async () => {
    fs.writeFileSync(consoleLogPath, "Old session line 1\n");
    const loaded = await loadLog(dataDir);
    // Two pages, both holding what the load gave them.
    const pageA = { size: loaded.size, identity: loaded.identity };
    const pageB = { size: loaded.size, identity: loaded.identity };

    // Real prior activity so the birthtime proof can establish itself on a
    // filesystem that tracks one (see consoleLogStreamFileIdentity.test.js).
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.appendFileSync(consoleLogPath, "Old session line 2\n");
    const grownA = await poll(dataDir, pageA.size, pageA.identity);
    const grownB = await poll(dataDir, pageB.size, pageB.identity);
    expect(grownA.newLines).toEqual(["Old session line 2"]);
    expect(grownB.newLines).toEqual(["Old session line 2"]);
    pageA.size = grownA.currentSize;
    pageB.size = grownB.currentSize;

    // PZ restarts; the new log is already bigger than both pages' offset.
    const newSession = "New session line A\nNew session line B\nNew session line C\nNew session line D\n";
    expect(Buffer.byteLength(newSession)).toBeGreaterThan(pageA.size);
    fs.unlinkSync(consoleLogPath);
    fs.writeFileSync(consoleLogPath, newSession);

    const a = await poll(dataDir, pageA.size, pageA.identity);
    expect(a.rotated).toBe(true);
    expect(a.newLines).toHaveLength(4);

    // The second page still holds the OLD token: it must be told too, and
    // get the whole new log, not a byte range cut out of the middle of it.
    const b = await poll(dataDir, pageB.size, pageB.identity);
    expect(b.rotated).toBe(true);
    expect(b.newLines).toEqual([
      "New session line A",
      "New session line B",
      "New session line C",
      "New session line D",
    ]);
    expect(b.identity).toBe(a.identity);
    expect(b.identity).not.toBe(pageB.identity);

    // Having taken the new token, neither page sees a rotation again.
    fs.appendFileSync(consoleLogPath, "New session line E\n");
    const afterA = await poll(dataDir, a.currentSize, a.identity);
    const afterB = await poll(dataDir, b.currentSize, b.identity);
    expect(afterA.rotated).toBeFalsy();
    expect(afterA.newLines).toEqual(["New session line E"]);
    expect(afterB.rotated).toBeFalsy();
    expect(afterB.newLines).toEqual(["New session line E"]);
  });

  it("a malformed identity token is ignored and the shared record decides, as for a page without one", async () => {
    fs.writeFileSync(consoleLogPath, "Line 1\n");
    const loaded = await loadLog(dataDir);
    fs.appendFileSync(consoleLogPath, "Line 2\n");

    const answer = await poll(dataDir, loaded.size, "not-a-token");

    expect(answer.rotated).toBeFalsy();
    expect(answer.newLines).toEqual(["Line 2"]);
  });
});
