import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.js";

// Security audit 2026-10-20: the local bridge transport read status.json,
// the outbox res-N.json results and queue-state-lua.json whole on every poll
// with no size limit (the SFTP transport refuses anything over 16 MB). Those
// files sit in a folder the game server's account can write. They now go
// through the same 16 MB ceiling, logged once per file, and an oversized
// result is skipped instead of stalling the queue.

const LIMIT = 16 * 1024 * 1024;

// A sparse-ish big file: one byte past the limit, written without holding
// it in memory twice.
function writeOversized(file, head = '{"version":"1.7.77","pad":"') {
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, head);
  fs.ftruncateSync(fd, LIMIT + 1);
  fs.closeSync(fd);
}

describe("local bridge files are size-capped", () => {
  let dir;
  let bridge;
  let readSpy;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-size-cap-"));
    fs.mkdirSync(path.join(dir, "outbox"), { recursive: true });
    bridge = new PanelBridge();
    bridge.configure(dir, true);
    readSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.stop?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readsOf = (file) => readSpy.mock.calls.filter(([p]) => path.resolve(String(p)) === path.resolve(file)).length;

  it("does not read an oversized status.json, and reports a status failure instead", () => {
    const status = path.join(dir, "status.json.txt");
    writeOversized(status);
    const before = bridge.consecutiveFailures;

    bridge.checkModStatus();
    bridge.lastStatusFileCheck = 0;
    bridge.checkModStatus();

    expect(readsOf(status)).toBe(0);
    expect(bridge.consecutiveFailures).toBe(before + 2);
    expect(bridge.modStatus?.pad).toBeUndefined();
  });

  it("still reads a normal status.json", () => {
    fs.writeFileSync(path.join(dir, "status.json.txt"), JSON.stringify({ version: "1.7.77", playerCount: 0 }));
    bridge.checkModStatus();
    expect(bridge.modStatus?.version).toBe("1.7.77");
  });

  it("skips an oversized result file without reading it, and the queue moves on", () => {
    bridge.ensureQueueProtocol();
    const seq = bridge.queueState.lastConsumedResultSeq + 1;
    const big = path.join(dir, "outbox", `res-${String(seq).padStart(10, "0")}.json.txt`);
    writeOversized(big, '{"result":{"id":"x","pad":"');
    const next = path.join(dir, "outbox", `res-${String(seq + 1).padStart(10, "0")}.json.txt`);
    fs.writeFileSync(next, JSON.stringify({ protocolVersion: "queue-v1", seq: seq + 1, result: { id: "nobody" } }));

    bridge.pollQueueResults();

    expect(readsOf(big)).toBe(0);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(seq + 1);
  });

  it("does not read an oversized queue-state-lua.json", () => {
    const luaState = path.join(dir, "queue-state-lua.json.txt");
    writeOversized(luaState, '{"nextResultSeq":');
    bridge.queueState.initialized = false;
    bridge.ensureQueueProtocol();
    expect(readsOf(luaState)).toBe(0);
  });
});
