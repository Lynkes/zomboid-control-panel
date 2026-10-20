import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Writable } from "stream";

// Security audit 2026-10-20: GET /api/debug/logs/download/:filename served
// ANY file in the logs folder whose name had no "..", "/" or "\" -- and the
// logs folder is configurable (POST /api/debug/paths). Pointing it at the
// data folder made jwt.secret and db.json downloadable by a diagnostics.manage
// role. The route now serves only what GET /logs/files lists: a regular file
// (not a link) directly in the logs folder, named *.log, spelled exactly as
// readdir() spells it.
//
// Real getDataPaths(): the per-file setup gives this file its own temp logs
// folder (see debugLogZipEntryStreamError.test.js).
const { getDataPaths } = await import("../utils/paths.js");
const logsDir = getDataPaths().logsDir;
fs.mkdirSync(logsDir, { recursive: true });
// Not combined.log: the panel's own logger appends to that one.
fs.writeFileSync(path.join(logsDir, "panel-old.log"), "a real log line\n");
// What the attack planted by moving the logs folder onto the data folder.
fs.writeFileSync(path.join(logsDir, "jwt.secret"), "TOP-SECRET-SIGNING-KEY");
fs.writeFileSync(path.join(logsDir, "notes.LOG"), "TOP-SECRET-UPPERCASE-EXTENSION");
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-logdl-outside-"));
fs.writeFileSync(path.join(outside, "db.json"), "TOP-SECRET-DATABASE");

afterAll(() => fs.rmSync(outside, { recursive: true, force: true }));

const { default: router } = await import("../routes/debug.js");

function getHandler(routePath) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.get);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

class CaptureRes extends Writable {
  constructor() {
    super();
    this.chunks = [];
    this.statusCode = 200;
    this.jsonBody = null;
    this.headers = {};
    this.headersSent = false;
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  setHeader(name, value) {
    this.headers[name] = value;
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.jsonBody = body;
    this.end();
    return this;
  }
  get text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function download(filename) {
  const res = new CaptureRes();
  const finished = new Promise((resolve) => res.on("finish", resolve));
  await getHandler("/logs/download/:filename")({ params: { filename } }, res);
  await finished;
  return res;
}

describe("GET /logs/download/:filename serves only listed log files", () => {
  it("serves a log file the listing shows", async () => {
    const res = await download("panel-old.log");
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe("a real log line\n");
  });

  it("refuses a non-log file in the logs folder (jwt.secret)", async () => {
    const res = await download("jwt.secret");
    expect(res.statusCode).toBe(404);
    expect(res.text).not.toContain("TOP-SECRET");
  });

  it.each([
    ["an alternate data stream", "jwt.secret::$DATA"],
    ["an alternate data stream named like a log", "jwt.secret:x.log"],
    ["a NUL byte", "jwt.secret\0.log"],
    ["a traversal", "..%2fdb.json"],
  ])("refuses %s", async (_label, filename) => {
    const res = await download(filename);
    expect(res.statusCode).toBe(400);
    expect(res.text).not.toContain("TOP-SECRET");
  });

  it.each([
    ["a trailing dot (Windows drops it)", "jwt.secret."],
    ["a trailing dot after .log", "panel-old.log."],
    ["a case alias of a secret", "JWT.SECRET"],
    ["a non-log file with an upper-case .LOG extension", "notes.LOG"],
    ["a case alias of a real log", "PANEL-OLD.LOG"],
    ["a name that does not exist", "missing.log"],
  ])("refuses %s", async (_label, filename) => {
    const res = await download(filename);
    expect(res.statusCode).toBe(404);
    expect(res.text).not.toContain("TOP-SECRET");
  });

  it("refuses a junction named x.log pointing at a folder outside", async () => {
    fs.symlinkSync(outside, path.join(logsDir, "folder.log"), "junction");
    const res = await download("folder.log");
    expect(res.statusCode).toBe(404);
  });

  it("refuses a symbolic link named x.log pointing at a secret", async (ctx) => {
    const link = path.join(logsDir, "evil.log");
    try {
      fs.symlinkSync(path.join(outside, "db.json"), link, "file");
    } catch (error) {
      // Windows without Developer Mode can't create file symlinks.
      if (error.code === "EPERM") return ctx.skip();
      throw error;
    }
    const res = await download("evil.log");
    expect(res.statusCode).toBe(404);
    expect(res.text).not.toContain("TOP-SECRET");
  });
});
