import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { PassThrough, Readable } from "stream";
import { fileURLToPath } from "url";
import express from "express";
import unzipper from "unzipper";
import { linkDir, makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// "Download as .zip" (spec §A6.4): every limit is checked before the first
// byte, links, special files, protected areas and unreadable files are
// skipped and listed in _skipped.txt, and the archive reads back. The
// additive StreamingZipWriter options keep backups unchanged
// (streamingZip.test.js covers that path).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRoleByName: async (name) => (name === "admin" ? { name, capabilities: ["files.manage"] } : null),
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
  };
});

const { default: filesRoutes } = await import("../routes/files.js");
const { planZip, acquireZipSlot, zipFileName, sweepStaleZipTemps, _resetZipSlotsForTests } = await import("../services/fileManagerZip.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { StreamingZipWriter } = await import("../utils/streamingZip.js");
const { getDataPaths } = await import("../utils/paths.js");
const { FM_LIMITS, FmError } = await import("../services/fileManagerContract.js");

let server;
let baseUrl;
let base;
let tree;

async function zip(paths, root = "data") {
  const response = await fetch(`${baseUrl}/api/files/profiles/p1/zip`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-role": "admin" },
    body: JSON.stringify({ root, paths }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

function fakeBackend(entries, kind = "local") {
  return {
    kind,
    async *walk() {
      for (const entry of entries) yield entry;
    },
  };
}

const dirItem = { rel: "big", realRel: "big", name: "big", rootId: "data", stat: { type: "dir", mtimeMs: 0 } };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: "u1", username: "kate", role: req.get("x-test-role") };
    next();
  });
  app.set("serverManager", { getServerProcessDetails: async () => ({ running: false, scanFailed: false }) });
  app.use("/api/files", filesRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  invalidateRootCache();
  _resetZipSlotsForTests();
});

afterEach(() => {
  removeDir(base);
});

describe("limits, checked before the first byte", () => {
  async function reasonOf(promise) {
    try {
      await promise;
      return null;
    } catch (err) {
      if (!(err instanceof FmError)) throw err;
      expect(err.code).toBe("FM_ZIP_TOO_LARGE");
      return err.params;
    }
  }

  it("entries", async () => {
    const many = Array.from({ length: FM_LIMITS.ZIP_MAX_ENTRIES.local + 1 }, (_, i) => ({
      rel: `big/f${i}`, realRel: `big/f${i}`, type: "file", size: 1, depth: 1,
    }));
    expect(await reasonOf(planZip({ backend: fakeBackend(many), items: [dirItem], classify: () => null }))).toEqual({
      reason: "entries",
      limit: FM_LIMITS.ZIP_MAX_ENTRIES.local,
    });
    const sftpLimit = FM_LIMITS.ZIP_MAX_ENTRIES.sftp;
    expect(
      await reasonOf(planZip({ backend: fakeBackend(many.slice(0, sftpLimit + 1), "sftp"), items: [dirItem], classify: () => null })),
    ).toEqual({ reason: "entries", limit: sftpLimit });
  });

  it("bytes", async () => {
    const huge = [{ rel: "big/a", realRel: "big/a", type: "file", size: FM_LIMITS.ZIP_MAX_BYTES.local + 1, depth: 1 }];
    expect(await reasonOf(planZip({ backend: fakeBackend(huge), items: [dirItem], classify: () => null }))).toEqual({
      reason: "bytes",
      limit: FM_LIMITS.ZIP_MAX_BYTES.local,
    });
  });

  it("depth", async () => {
    const deep = [{ rel: "big/x", realRel: "big/x", type: "dir", size: 0, depth: FM_LIMITS.ZIP_MAX_DEPTH + 1 }];
    expect(await reasonOf(planZip({ backend: fakeBackend(deep), items: [dirItem], classify: () => null }))).toEqual({
      reason: "depth",
      limit: FM_LIMITS.ZIP_MAX_DEPTH,
    });
  });

  it("time", async () => {
    let t = 0;
    const slow = Array.from({ length: 3 }, (_, i) => ({ rel: `big/${i}`, realRel: `big/${i}`, type: "file", size: 1, depth: 1 }));
    const params = await reasonOf(
      planZip({ backend: fakeBackend(slow), items: [dirItem], classify: () => null, now: () => (t += 3000) }),
    );
    expect(params.reason).toBe("time");
  });

  it("an oversized selection is a JSON 413, not a cut-off download", async () => {
    fs.writeFileSync(path.join(tree.data, "sparse.bin"), "");
    fs.truncateSync(path.join(tree.data, "sparse.bin"), FM_LIMITS.ZIP_MAX_BYTES.local + 1);
    const res = await zip(["sparse.bin"]);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.buffer.toString("utf8"))).toMatchObject({ code: "FM_ZIP_TOO_LARGE", params: { reason: "bytes" } });
  });

  it("slots: one zip per user, two across the panel", () => {
    const release = acquireZipSlot("u1");
    expect(() => acquireZipSlot("u1")).toThrow(FmError);
    const other = acquireZipSlot("u2");
    expect(() => acquireZipSlot("u3")).toThrow(FmError);
    release();
    other();
    acquireZipSlot("u3")();
  });

  it("names the file from the server, root and selection", () => {
    const name = zipFileName("My Server!", "data", [{ rel: "Saves/Multiplayer" }], new Date(2026, 8, 29, 12, 5));
    expect(name).toBe("My_Server_-data-Multiplayer-20260929-1205.zip");
    expect(zipFileName("s", "install", [{ rel: "a" }, { rel: "b" }], new Date(2026, 0, 2, 3, 4))).toBe("s-install-install-20260102-0304.zip");
  });
});

describe("contents", () => {
  it("reads back, masks .ini, and lists what it skipped", async () => {
    linkDir(tree.outside, path.join(tree.data, "Server", "escape"));
    const { dataDir } = getDataPaths();
    const secret = write(path.join(dataDir, "jwt.secret"), "JWT-SECRET-VALUE");
    fs.linkSync(secret, path.join(tree.data, "Server", "alias.txt"));
    write(path.join(tree.data, "Server", "nested", "deep.txt"), "deep");
    fs.mkdirSync(path.join(tree.data, "Server", "empty"));

    const res = await zip(["Server", "Logs/server.txt"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="servertest-data-data-\d{8}-\d{4}\.zip"/);
    const archive = await unzipper.Open.buffer(res.buffer);
    const names = archive.files.map((f) => f.path).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "Server/",
        "Server/empty/",
        "Server/nested/",
        "Server/nested/deep.txt",
        "Server/servertest.ini",
        "Server/servertest_SandboxVars.lua",
        "server.txt",
        "_skipped.txt",
      ]),
    );
    expect(names).not.toContain("Server/alias.txt");
    expect(names.some((n) => n.startsWith("Server/escape"))).toBe(false);
    const read = async (name) => (await archive.files.find((f) => f.path === name).buffer()).toString("utf8");
    expect(await read("Server/nested/deep.txt")).toBe("deep");
    expect(await read("server.txt")).toBe("log line\n");
    expect(await read("Server/servertest.ini")).not.toContain("hunter2secret");
    const skipped = await read("_skipped.txt");
    expect(skipped).toContain("Server/escape: link");
    expect(skipped).toContain("Server/alias.txt: protected");
    expect(res.buffer.includes(Buffer.from("JWT-SECRET-VALUE"))).toBe(false);
    expect(res.buffer.includes(Buffer.from("CANARY-OUTSIDE-ROOT"))).toBe(false);
  });

  it("skips the list-only backups folder inside a bigger selection", async () => {
    const res = await zip([""]);
    expect(res.status).toBe(200);
    const archive = await unzipper.Open.buffer(res.buffer);
    const names = archive.files.map((f) => f.path);
    expect(names.some((n) => n.includes("world-1.zip"))).toBe(false);
    const skipped = (await archive.files.find((f) => f.path === "_skipped.txt").buffer()).toString("utf8");
    expect(skipped).toMatch(/backups: protected/);
  });

  it("a protected selection itself is refused before anything is sent", async () => {
    const res = await zip(["backups"]);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.buffer.toString("utf8")).code).toBe("FM_PATH_PROTECTED");
  });
});

describe("a zip into a real HTTP response whose client goes away", () => {
  // Live QA: a client that read a little of a zip and left could hold the
  // zip slot until the panel restarted: http never calls back a write it
  // parked once the client's FIN ended the socket, and a closing response
  // emits no 'error', so the writer's write never settled. The race only
  // shows in plain node (see the helper), so it runs there.
  it("settles every time, with its source stopped and its temp file removed", () => {
    const tempDir = makeTempDir("zcp-zip-tmp-");
    try {
      const child = spawnSync(process.execPath, [path.join(__dirname, "helpers", "zipClientGoneChild.mjs"), tempDir, "12"], {
        encoding: "utf8",
        timeout: 50000,
      });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout.trim().split("\n").pop());
      expect(result.outcomes).toEqual(Array(12).fill("ERR_STREAM_DESTROYED"));
      expect(result.sourcesLeftOpen).toBe(0);
      expect(result.tempFilesLeft).toEqual([]);
    } finally {
      removeDir(tempDir);
    }
  }, 60000);

  it("an abort while an entry is being read stops it, and nothing is made again", async () => {
    const tempDir = makeTempDir("zcp-zip-tmp-");
    try {
      const out = new PassThrough();
      out.resume();
      const writer = new StreamingZipWriter(null, { outputStream: out, tempDir });
      const source = new Readable({ read() {} });
      source.push(Buffer.alloc(1024, 1));
      const adding = writer.addStream(source, "stuck.bin");
      adding.catch(() => {});
      await new Promise((done) => setTimeout(done, 50));
      await writer.abort();
      await expect(adding).rejects.toMatchObject({ code: "ERR_STREAM_DESTROYED" });
      expect(source.destroyed).toBe(true);
      // A caller that goes on after the abort gets an error, not a new temp file.
      await expect(writer.addBuffer(Buffer.from("x"), "later.txt")).rejects.toMatchObject({ code: "ERR_STREAM_DESTROYED" });
      await expect(writer.finalize()).rejects.toMatchObject({ code: "ERR_STREAM_DESTROYED" });
      expect(fs.readdirSync(tempDir)).toEqual([]);
    } finally {
      removeDir(tempDir);
    }
  });
});

describe("a zip's slot", () => {
  // CI flake on PR #184 and #177 (fileManagerSftpOpenssh.test.js, "a zip
  // the client abandons": 429 instead of 200), diagnosed by Lynkes in #183:
  // the route gave the slot back in its finally, after the response had
  // ended and the central-directory temp file was removed, so a client that
  // asked for its next zip as soon as the last byte arrived could beat it.
  // Here that clean-up is held until the next zip has been answered, which
  // makes the old order fail every time.
  it("is free by the time the client has the whole zip", async () => {
    const realRm = fs.promises.rm.bind(fs.promises);
    let openGate;
    const gate = new Promise((done) => {
      openGate = done;
    });
    // The writer removes its temp file twice: before creating it (nothing
    // there yet) and once the archive is out. Only the second waits.
    let held = 0;
    const rm = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (path.basename(String(target)).startsWith(".central-") && fs.existsSync(target)) {
        held++;
        await gate;
      }
      return realRm(target, options);
    });
    try {
      const first = await zip(["Server"]);
      expect(first.status).toBe(200);
      expect((await unzipper.Open.buffer(first.buffer)).files.length).toBeGreaterThan(0);
      const next = await zip(["Logs"]);
      expect(next.status, next.buffer.toString("utf8").slice(0, 200)).toBe(200);
      // Both were answered while their clean-up was still held.
      expect(held).toBe(2);
      // Both zips' slots are back, and once each: two users fit across the
      // panel, a third doesn't.
      expect(() => acquireZipSlot("u1")).not.toThrow(FmError);
      expect(() => acquireZipSlot("u2")).not.toThrow(FmError);
      expect(() => acquireZipSlot("u3")).toThrow(FmError);
    } finally {
      openGate();
      rm.mockRestore();
    }
    // Let the two handlers finish their clean-up before afterEach.
    for (const started = Date.now(); Date.now() - started < 2000; ) {
      const left = fs
        .readdirSync(path.join(getDataPaths().dataDir, "file-manager-tmp"))
        .filter((name) => name.startsWith(".central-"));
      if (left.length === 0) break;
      await new Promise((done) => setTimeout(done, 20));
    }
  });

  it("is given back once when the zip ends early, and once when it completes", async () => {
    const out = new PassThrough();
    out.resume();
    let releases = 0;
    const { streamZip } = await import("../services/fileManagerZip.js");
    const plan = { dirs: [], files: [], skipped: [] };
    const result = await streamZip({ res: out, backend: null, root: null, plan, release: () => releases++ });
    expect(result.aborted).toBe(false);
    expect(releases).toBe(1);

    const gone = new PassThrough();
    gone.destroy();
    releases = 0;
    const cut = await streamZip({ res: gone, backend: null, root: null, plan, release: () => releases++ });
    expect(cut.aborted).toBe(true);
    expect(releases).toBe(1);
  });
});

describe("zip temp files", () => {
  it("those of an earlier run, or past the time cap, are swept; a running zip's and anything else stay", () => {
    const dir = path.join(getDataPaths().dataDir, "file-manager-tmp");
    fs.mkdirSync(dir, { recursive: true });
    const make = (name, ageMs) => {
      const abs = path.join(dir, name);
      fs.writeFileSync(abs, "");
      const at = new Date(Date.now() - ageMs);
      fs.utimesSync(abs, at, at);
      return abs;
    };
    const beforeStart = make(".central-42348-1759000000000-abc123.tmp", (process.uptime() + 60) * 1000);
    const pastCap = make(`.central-${process.pid}-1759000000001-def456.tmp`, FM_LIMITS.ZIP_TIME_LIMIT_MS + 5 * 60 * 1000);
    const fresh = make(`.central-${process.pid}-1759000000002-0a1b2c.tmp`, 0);
    const other = make("notes.txt", (process.uptime() + 60) * 1000);
    try {
      expect(sweepStaleZipTemps()).toBe(2);
      expect([beforeStart, pastCap, fresh, other].map((p) => fs.existsSync(p))).toEqual([false, false, true, true]);
    } finally {
      for (const p of [fresh, other]) fs.rmSync(p, { force: true });
    }
  });
});

describe("StreamingZipWriter's additive options", () => {
  it("writes into a caller's stream with its central directory in tempDir", async () => {
    const tempDir = makeTempDir("zcp-zip-tmp-");
    try {
      const out = new PassThrough();
      const chunks = [];
      out.on("data", (c) => chunks.push(c));
      const writer = new StreamingZipWriter(null, { outputStream: out, tempDir });
      await writer.addBuffer(Buffer.from("hello"), "a/hello.txt");
      await writer.finalize();
      expect(fs.readdirSync(tempDir)).toEqual([]);
      const archive = await unzipper.Open.buffer(Buffer.concat(chunks));
      expect((await archive.files[0].buffer()).toString()).toBe("hello");
    } finally {
      removeDir(tempDir);
    }
  });
});
