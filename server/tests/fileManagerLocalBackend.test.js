import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { IS_WIN, fakeApp, linkDir, makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// The local backend's write paths (spec §A6), driven through the service the
// way the routes drive them: file modes, byte-exact text round trips, the
// editor's compare-and-swap, upload landing and its rollback, the orphan
// sweep, the free-space floor, OS error mapping, and the per-root Trash.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));
const hooks = vi.hoisted(() => ({ renamePath: null, diskFree: null }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
  };
});

vi.mock("../services/fileManagerLocalFs.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renamePath: (from, to) => (hooks.renamePath ? hooks.renamePath(from, to, actual.renamePath) : actual.renamePath(from, to)),
  };
});

vi.mock("../utils/diskSpace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDiskFree: async (p) => (hooks.diskFree ? hooks.diskFree(p) : actual.getDiskFree(p)),
  };
});

const service = await import("../services/fileManagerService.js");
const { localBackend, mapFsError, sweepOrphanTemps } = await import("../services/fileManagerLocalBackend.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _setRunStateDepsForTests, _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const { _waitForJobForTests, _resetJobsForTests } = await import("../services/fileManagerJobs.js");
const { runFileManagerJanitor } = await import("../services/fileManagerJanitor.js");
const { describeProfileRoots } = await import("../services/fileManagerRoots.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");
const { startJob } = await import("../services/fileManagerJobs.js");
const { foldRel } = await import("../services/fileManagerProtectedAreas.js");
const trash = await import("../services/fileManagerTrash.js");
const { FmError } = await import("../services/fileManagerContract.js");

const user = { userId: "u1", username: "kate", role: "admin" };
let base;
let tree;

function audit() {
  const scope = { deferred: false };
  scope.defer = () => {
    scope.deferred = true;
    return { finish: async () => {} };
  };
  return scope;
}

async function ctx(app = fakeApp()) {
  return service.loadProfileContext(tree.profile.id, app);
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FmError) return err;
    throw err;
  }
  throw new Error("expected an FmError");
}

function uploadRequest({ root = "data", dir = "", name, body, headers = {} }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const all = {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.length),
    "x-file-root": root,
    "x-file-dir": encodeURIComponent(dir),
    "x-file-name": encodeURIComponent(name),
    ...headers,
  };
  const stream = Readable.from([bytes]);
  stream.get = (key) => all[key.toLowerCase()];
  return stream;
}

async function upload(opts, c) {
  return service.receiveUpload(c || (await ctx()), uploadRequest(opts), user, audit());
}

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  hooks.renamePath = null;
  hooks.diskFree = null;
  invalidateRootCache();
  _setRunStateDepsForTests({});
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(() => {
  removeDir(base);
});

describe("file modes (POSIX)", () => {
  it.skipIf(IS_WIN)("an edited 0755 script stays 0755, a new file is 0644, setuid is stripped", async () => {
    const script = path.join(tree.install, "start-server.sh");
    fs.chmodSync(script, 0o755);
    const c = await ctx();
    const read = await service.readText(c, { root: "install", path: "start-server.sh" });
    await service.saveText(
      c,
      { root: "install", path: "start-server.sh", content: "#!/bin/sh\necho edited\n", etag: read.etag, eol: "lf", bom: false, confirm: ["executable"] },
      user,
      audit(),
    );
    expect(fs.statSync(script).mode & 0o7777).toBe(0o755);

    await service.saveText(
      await ctx(),
      { root: "data", path: "Server/new.txt", content: "hi", etag: null, eol: "lf", bom: false, confirm: [] },
      user,
      audit(),
    );
    expect(fs.statSync(path.join(tree.config, "new.txt")).mode & 0o7777).toBe(0o644);

    const suid = write(path.join(tree.data, "suid.txt"), "x");
    fs.chmodSync(suid, 0o4755);
    const again = await ctx();
    const r = await service.readText(again, { root: "data", path: "suid.txt" });
    await service.saveText(again, { root: "data", path: "suid.txt", content: "y", etag: r.etag, eol: "lf", bom: false, confirm: [] }, user, audit());
    expect(fs.statSync(suid).mode & 0o7777).toBe(0o755);
  });
});

describe("text round trips", () => {
  it("a BOM and CRLF file round-trips byte for byte", async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a=1\r\nb=2\r\n", "utf8")]);
    const file = path.join(tree.data, "roundtrip.cfg");
    fs.writeFileSync(file, original);
    const c = await ctx();
    const read = await service.readText(c, { root: "data", path: "roundtrip.cfg" });
    expect(read).toMatchObject({ content: "a=1\nb=2\n", bom: true, eol: "crlf", masked: false });
    const saved = await service.saveText(
      c,
      { root: "data", path: "roundtrip.cfg", content: read.content, etag: read.etag, eol: "crlf", bom: true, confirm: [] },
      user,
      audit(),
    );
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(saved.body.etag).toBe(read.etag);
    expect(saved.body.previousVersion.trashId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  });

  it("Latin-1 and UTF-16 are refused as unsupported encodings, NUL as binary", async () => {
    fs.writeFileSync(path.join(tree.data, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    fs.writeFileSync(path.join(tree.data, "utf16.txt"), Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    fs.writeFileSync(path.join(tree.data, "zeros.txt"), Buffer.from([0x61, 0x00, 0x62]));
    const c = await ctx();
    expect((await failure(service.readText(c, { root: "data", path: "latin1.txt" }))).code).toBe("FM_ENCODING_UNSUPPORTED");
    expect((await failure(service.readText(c, { root: "data", path: "utf16.txt" }))).code).toBe("FM_ENCODING_UNSUPPORTED");
    expect((await failure(service.readText(c, { root: "data", path: "zeros.txt" }))).code).toBe("FM_BINARY_FILE");
    expect((await failure(service.readText(c, { root: "data", path: "db/servertest.db" }))).code).toBe("FM_BINARY_FILE");
  });

  it("a stale etag is a conflict that carries the current one", async () => {
    const c = await ctx();
    const read = await service.readText(c, { root: "data", path: "Server/servertest_SandboxVars.lua" });
    fs.writeFileSync(path.join(tree.config, "servertest_SandboxVars.lua"), "SandboxVars = { changed = true }\n");
    const err = await failure(
      service.saveText(
        c,
        { root: "data", path: "Server/servertest_SandboxVars.lua", content: "mine", etag: read.etag, eol: "lf", bom: false, confirm: [] },
        user,
        audit(),
      ),
    );
    expect(err.code).toBe("FM_CONFLICT");
    expect(err.params.currentEtag).toMatch(/^h:[0-9a-f]{64}$/);
    expect(err.params.currentEtag).not.toBe(read.etag);
  });

  it("the tail view reads the end of a large file, read-only", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    write(path.join(tree.data, "Logs", "big.txt"), lines);
    const c = await ctx();
    const tail = await service.readText(c, { root: "data", path: "Logs/big.txt", mode: "tail", tailBytes: "1000" });
    expect(tail.readOnly).toBe(true);
    expect(tail.readOnlyReason).toBe("tail");
    expect(tail.truncated).toBe(true);
    expect(tail.content.endsWith("line 4999")).toBe(true);
    expect(tail.content.startsWith("line ")).toBe(true);
  });

  it("files over the editor limit are refused with the limit", async () => {
    fs.writeFileSync(path.join(tree.data, "huge.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const err = await failure(service.readText(await ctx(), { root: "data", path: "huge.txt" }));
    expect(err.code).toBe("FM_FILE_TOO_LARGE_FOR_EDITOR");
    expect(err.status).toBe(413);
  });
});

describe("uploads", () => {
  it("two concurrent uploads of one name: exactly one lands, the other gets FM_EXISTS", async () => {
    const c1 = await ctx();
    const c2 = await ctx();
    const results = await Promise.allSettled([
      upload({ dir: "Server", name: "race.txt", body: "one" }, c1),
      upload({ dir: "Server", name: "race.txt", body: "two" }, c2),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe("FM_EXISTS");
    expect(["one", "two"]).toContain(fs.readFileSync(path.join(tree.config, "race.txt"), "utf8"));
    expect(fs.readdirSync(tree.config).some((n) => n.endsWith(".zcpupload"))).toBe(false);
  });

  it("an existing name needs the overwrite etag and the overwrite token; the old file goes to Trash", async () => {
    const c = await ctx();
    const target = write(path.join(tree.data, "notes.txt"), "old");
    const exists = await failure(upload({ name: "notes.txt", body: "new" }, c));
    expect(exists.code).toBe("FM_EXISTS");
    const stat = await service.statPath(c, { root: "data", path: "notes.txt" });
    const needsToken = await failure(upload({ name: "notes.txt", body: "new", headers: { "x-file-overwrite-etag": stat.entry.etag } }, c));
    expect(needsToken.code).toBe("FM_CONFIRMATION_REQUIRED");
    expect(needsToken.params.required).toEqual(["overwrite"]);
    const result = await upload(
      { name: "notes.txt", body: "new", headers: { "x-file-overwrite-etag": stat.entry.etag, "x-file-confirm": "overwrite" } },
      c,
    );
    expect(fs.readFileSync(target, "utf8")).toBe("new");
    expect(result.replaced.trashId).toMatch(/^\d{8}T/);
    const items = trash.listTrash(tree.data);
    expect(items[0]).toMatchObject({ originalPath: "notes.txt", reason: "replaced" });
  });

  it("when the second rename of an overwrite fails, the old file is put back", async () => {
    const target = write(path.join(tree.data, "keep.txt"), "original");
    const c = await ctx();
    const stat = await service.statPath(c, { root: "data", path: "keep.txt" });
    hooks.renamePath = (from, to, real) => {
      if (from.endsWith(".zcpupload")) {
        const err = new Error("simulated");
        err.code = "EIO";
        throw err;
      }
      return real(from, to);
    };
    const err = await failure(
      upload({ name: "keep.txt", body: "replacement", headers: { "x-file-overwrite-etag": stat.entry.etag, "x-file-confirm": "overwrite" } }, c),
    );
    expect(err.code).toBe("FM_INTERNAL");
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(trash.listTrash(tree.data)).toHaveLength(0);
    expect(fs.readdirSync(tree.data).some((n) => n.endsWith(".zcpupload"))).toBe(false);
  });

  it("a size mismatch saves nothing", async () => {
    const c = await ctx();
    const req = uploadRequest({ name: "short.txt", body: "abc" });
    const headers = { "content-length": "10" };
    const original = req.get;
    req.get = (k) => headers[k.toLowerCase()] ?? original(k);
    const err = await failure(service.receiveUpload(c, req, user, audit()));
    expect(err.code).toBe("FM_UPLOAD_SIZE_MISMATCH");
    expect(fs.existsSync(path.join(tree.data, "short.txt"))).toBe(false);
    expect(fs.readdirSync(tree.data).some((n) => n.endsWith(".zcpupload"))).toBe(false);
  });

  it("a folder upload creates missing levels only with X-File-Mkdirs", async () => {
    const c = await ctx();
    const refused = await failure(upload({ dir: "mods/NewMod/media", name: "mod.info", body: "name=x" }, c));
    expect(refused.code).toBe("FM_NOT_FOUND");
    expect(fs.existsSync(path.join(tree.data, "mods"))).toBe(false);
    await upload({ dir: "mods/NewMod/media", name: "mod.info", body: "name=x", headers: { "x-file-mkdirs": "1" } }, c);
    expect(fs.readFileSync(path.join(tree.data, "mods", "NewMod", "media", "mod.info"), "utf8")).toBe("name=x");
  });

  it("missing levels are checked like any new name", async () => {
    const err = await failure(
      upload({ dir: "backups/new", name: "x.txt", body: "x", headers: { "x-file-mkdirs": "1" } }),
    );
    expect(err.code).toBe("FM_PATH_PROTECTED");
    const reserved = await failure(upload({ dir: "", name: "x.zcpupload", body: "x" }));
    expect(reserved.code).toBe("FM_INVALID_NAME");
  });

  it("the free-space floor refuses an upload that would leave less than 1 GiB", async () => {
    hooks.diskFree = async () => ({ free: 1024 * 1024 * 1024 + 10, total: 10 * 1024 * 1024 * 1024 });
    const err = await failure(upload({ name: "big.bin", body: Buffer.alloc(100) }));
    expect(err.code).toBe("FM_INSUFFICIENT_SPACE");
    expect(err.status).toBe(507);
    expect(err.params.required).toBe(100 + 1024 * 1024 * 1024);
  });

  it("orphaned temps of a dead process older than an hour are swept on the next write", async () => {
    const old = write(path.join(tree.data, ".x.txt.999999.abcdef12.zcpupload"), "orphan");
    const fresh = write(path.join(tree.data, ".y.txt.999999.abcdef13.zcpupload"), "fresh");
    const mine = write(path.join(tree.data, `.z.txt.${process.pid}.abcdef14.zcptmp`), "mine");
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, hoursAgo, hoursAgo);
    fs.utimesSync(mine, hoursAgo, hoursAgo);
    await upload({ name: "trigger.txt", body: "t" });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(mine)).toBe(true);
    expect(sweepOrphanTemps(tree.data)).toBe(0);
  });
});

describe("big folders", () => {
  it("over 2000 entries: sorted by name only, and only the page is stat'ed", async () => {
    const dir = path.join(tree.data, "many");
    fs.mkdirSync(dir);
    for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "");
    const listing = await service.listDir(await ctx(), { root: "data", path: "many", limit: "500", sort: "size" });
    expect(listing.sortLimited).toBe(true);
    expect(listing.total).toBe(2100);
    expect(listing.entries).toHaveLength(500);
    expect(listing.entries.slice(0, 3).map((e) => e.name)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(listing.entries[10].name).toBe("f10.txt");
    const next = await service.listDir(await ctx(), { root: "data", path: "many", offset: "2000", limit: "1000" });
    expect(next.entries).toHaveLength(100);
    expect(next.dirEtag).toBe(listing.dirEtag);
  });
});

describe("gates on mutations", () => {
  it("a lifecycle operation or a running file job on the path refuses the change", async () => {
    const lock = acquireLifecycleLock("start", tree.profile.id);
    try {
      const err = await failure(service.makeDirectory(await ctx(), { root: "data", path: "", name: "x", confirm: [] }, user, audit()));
      expect(err.code).toBe("FM_OPERATION_IN_PROGRESS");
      expect(err.params).toEqual({ operation: "lifecycle" });
    } finally {
      lock.release();
    }
    const c = await ctx();
    const info = await describeProfileRoots(tree.profile, {});
    const key = info.roots.get("data").key;
    let finish;
    const jobId = startJob({ ownerUserId: "u1", kind: "permanentDelete", holds: [{ rootKey: key, realRel: foldRel("Logs") }] }, () => new Promise((resolve) => (finish = resolve)));
    try {
      const err = await failure(service.makeDirectory(c, { root: "data", path: "Logs", name: "x", confirm: [] }, user, audit()));
      expect(err.code).toBe("FM_OPERATION_IN_PROGRESS");
      expect(err.params).toEqual({ operation: "fileJob" });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finish?.();
      await _waitForJobForTests(jobId);
    }
  });

  it("a read-only root refuses every change", async () => {
    const info = await describeProfileRoots(tree.profile, {});
    info.roots.get("data").writable = false;
    info.roots.get("data").readOnlyReason = "mount";
    const err = await failure(service.makeDirectory(await ctx(), { root: "data", path: "", name: "x", confirm: [] }, user, audit()));
    expect(err.code).toBe("FM_ROOT_READ_ONLY");
    expect(err.params).toEqual({ reason: "mount" });
    const listing = await service.listDir(await ctx(), { root: "data", path: "Server" });
    expect(listing.entries.every((e) => !e.flags.editable)).toBe(true);
  });

  it("an upload never writes through a link, even one to a file inside the root", async () => {
    linkDir(path.join(tree.data, "Server"), path.join(tree.data, "cfg"));
    const c = await ctx();
    const err = await failure(upload({ name: "cfg", body: "x", headers: { "x-file-overwrite-etag": "s:1-1-1", "x-file-confirm": "overwrite" } }, c));
    expect(err.code).toBe("FM_EXISTS");
    expect(fs.lstatSync(path.join(tree.data, "cfg")).isSymbolicLink()).toBe(true);
  });
});

describe("OS errors", () => {
  it("map to codes that never carry a path", () => {
    const withCode = (c) => Object.assign(new Error(`EXAMPLE: ${tree.data}`), { code: c });
    expect(mapFsError(withCode("EROFS"))).toMatchObject({ code: "FM_ROOT_READ_ONLY", params: { reason: "mount" } });
    expect(mapFsError(withCode("EBUSY")).code).toBe("FM_FILE_IN_USE");
    expect(mapFsError(withCode("EACCES"))).toMatchObject({ code: "FM_OS_PERMISSION_DENIED", params: { detail: "EACCES" } });
    expect(mapFsError(withCode("ENOSPC")).code).toBe("FM_INSUFFICIENT_SPACE");
    expect(mapFsError(withCode("EXDEV")).code).toBe("FM_CROSS_DEVICE");
    expect(mapFsError(withCode("EPERM")).code).toBe(IS_WIN ? "FM_FILE_IN_USE" : "FM_OS_PERMISSION_DENIED");
    const unknown = mapFsError(withCode("EWEIRD"));
    expect(unknown.code).toBe("FM_INTERNAL");
    expect(JSON.stringify({ ...unknown, message: unknown.message })).not.toContain(tree.data);
  });

  it.skipIf(!IS_WIN)("a read-only file on Windows is FM_TARGET_READ_ONLY", async () => {
    const file = write(path.join(tree.data, "ro.txt"), "locked");
    fs.chmodSync(file, 0o444);
    try {
      const c = await ctx();
      const read = await service.readText(c, { root: "data", path: "ro.txt" });
      const err = await failure(
        service.saveText(c, { root: "data", path: "ro.txt", content: "x", etag: read.etag, eol: "lf", bom: false, confirm: [] }, user, audit()),
      );
      expect(err.code).toBe("FM_TARGET_READ_ONLY");
      expect(fs.readFileSync(file, "utf8")).toBe("locked");
    } finally {
      fs.chmodSync(file, 0o666);
    }
  });
});

describe("Trash", () => {
  async function trashDelete(paths, c) {
    const context = c || (await ctx());
    const preview = await service.deletePreview(context, { root: "data", paths }, user);
    return service.deleteItems(context, { root: "data", previewId: preview.previewId, mode: "trash", confirm: preview.required }, user, audit());
  }

  it("delete moves to Trash; restore puts it back; restore-as when the name is taken", async () => {
    write(path.join(tree.data, "Logs", "old.txt"), "old log");
    const result = await trashDelete(["Logs/old.txt"]);
    expect(result.body.failed).toEqual([]);
    const trashId = result.body.trashed[0].trashId;
    expect(fs.existsSync(path.join(tree.data, "Logs", "old.txt"))).toBe(false);

    const listing = await service.listTrashItems(await ctx(), { root: "data" });
    expect(listing.items[0]).toMatchObject({ trashId, originalPath: "Logs/old.txt", reason: "deleted", deletedBy: { username: "kate" } });
    expect(Date.parse(listing.items[0].expiresAt) - Date.parse(listing.items[0].deletedAt)).toBeGreaterThan(6.9 * 24 * 3600 * 1000);

    write(path.join(tree.data, "Logs", "old.txt"), "newer");
    const taken = await failure(service.restoreTrashItem(await ctx(), { root: "data", trashId }, user, audit()));
    expect(taken.code).toBe("FM_EXISTS");
    const restored = await service.restoreTrashItem(await ctx(), { root: "data", trashId, restoreAs: "old (restored).txt" }, user, audit());
    expect(restored.entry.name).toBe("old (restored).txt");
    expect(fs.readFileSync(path.join(tree.data, "Logs", "old (restored).txt"), "utf8")).toBe("old log");
    expect(trash.listTrash(tree.data)).toHaveLength(0);
  });

  it("items older than 7 days expire in the janitor's pass", async () => {
    write(path.join(tree.data, "Logs", "a.txt"), "a");
    await trashDelete(["Logs/a.txt"]);
    expect(trash.listTrash(tree.data)).toHaveLength(1);
    const early = await runFileManagerJanitor({ now: Date.now() + 6 * 24 * 3600 * 1000 });
    expect(early.expired).toBe(0);
    const late = await runFileManagerJanitor({ now: Date.now() + 8 * 24 * 3600 * 1000 });
    expect(late.expired).toBe(1);
    expect(trash.countTrashItems(tree.data)).toBe(0);
  });

  it("each file keeps at most 20 edited versions, oldest first out", async () => {
    const rel = "Server/servertest_SandboxVars.lua";
    for (let i = 0; i < 22; i++) {
      const c = await ctx();
      const read = await service.readText(c, { root: "data", path: rel });
      await service.saveText(c, { root: "data", path: rel, content: `SandboxVars = { v = ${i} }\n`, etag: read.etag, eol: "lf", bom: false, confirm: [] }, user, audit());
    }
    const versions = (await service.listTrashItems(await ctx(), { root: "data", originalPath: rel })).items;
    expect(versions).toHaveLength(20);
    expect(versions.every((v) => v.reason === "edited")).toBe(true);
  });

  it("an item on another device than the Trash folder can't go to Trash", async () => {
    const root = await localBackend.describeRoot({ id: "data", path: tree.data });
    const r = await localBackend.resolve(root, ["Logs", "server.txt"], "delete");
    expect(localBackend.trashAvailability(root, [{ ...r, stat: { ...r.stat, dev: r.stat.dev + 1n } }])).toEqual({
      available: false,
      reason: "crossDevice",
    });
    const err = (() => {
      try {
        trash.moveToTrash(root.real, r.abs, { originalPath: r.realRel, type: "file", dev: r.stat.dev + 1n });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err.code).toBe("FM_TRASH_UNAVAILABLE");
    expect(err.params).toEqual({ reason: "crossDevice" });
    expect(fs.existsSync(r.abs)).toBe(true);
  });

  it("a link squatting on the Trash folder's name makes Trash unavailable instead of being followed", async () => {
    linkDir(tree.outside, path.join(tree.data, ".zcp-trash"));
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: ["Logs/server.txt"] }, user);
    expect(preview.trashAvailable).toBe(false);
    expect(preview.trashUnavailableReason).toBe("notWritable");
    const result = await service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "trash", confirm: [] }, user, audit());
    expect(result.body.failed[0].code).toBe("FM_TRASH_UNAVAILABLE");
    expect(fs.readdirSync(tree.outside)).toEqual(["canary.txt"]);
  });

  it("permanent delete runs as a job, needs the typed name, and never follows links", async () => {
    const doomed = path.join(tree.data, "doomed");
    write(path.join(doomed, "a", "b.txt"), "b");
    linkDir(tree.outside, path.join(doomed, "a", "escape"));
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: ["doomed"] }, user);
    const mismatch = await failure(
      service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "permanent", confirm: ["permanent"], typedConfirmation: "nope" }, user, audit()),
    );
    expect(mismatch.code).toBe("FM_TYPED_CONFIRMATION_MISMATCH");
    const started = await service.deleteItems(
      c,
      { root: "data", previewId: preview.previewId, mode: "permanent", confirm: ["permanent"], typedConfirmation: "doomed" },
      user,
      audit(),
    );
    expect(started.status).toBe(202);
    const job = await _waitForJobForTests(started.body.jobId);
    expect(job.state).toBe("done");
    expect(fs.existsSync(doomed)).toBe(false);
    expect(fs.readFileSync(path.join(tree.outside, "canary.txt"), "utf8")).toBe("CANARY-OUTSIDE-ROOT");
  });
});
