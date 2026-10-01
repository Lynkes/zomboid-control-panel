import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { PassThrough, Readable } from "stream";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { IS_WIN, linkDir, makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// The local backend when the disk says no (spec §A6): a write that fails at
// the very end, an upload cut off with writes in flight, a temp file that
// can't be created, a save whose rename fails, a Trash purge that stops
// partway, a planted Trash payload link, leftovers from an earlier
// container, case-only renames, filesystems without hard links, folders the
// panel can't list, names that aren't valid Unicode, Windows permissions and
// a folder that keeps filling while it is deleted.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));
const hooks = vi.hoisted(() => ({}));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
  };
});

// Every helper the backend and the Trash module call can be made to fail.
vi.mock("../services/fileManagerLocalFs.js", async (importOriginal) => {
  const actual = await importOriginal();
  const hooked = (name) => (...args) => (hooks[name] ? hooks[name](actual[name], ...args) : actual[name](...args));
  return {
    ...actual,
    createTempFile: hooked("createTempFile"),
    renamePath: hooked("renamePath"),
    linkPath: hooked("linkPath"),
    readDirEntries: hooked("readDirEntries"),
    mkdirPath: hooked("mkdirPath"),
  };
});

const { localBackend, mapFsError, sweepOrphanTemps } = await import("../services/fileManagerLocalBackend.js");
const trash = await import("../services/fileManagerTrash.js");
const service = await import("../services/fileManagerService.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests, _setRunStateDepsForTests } = await import("../services/fileManagerRunState.js");
const { _resetJobsForTests } = await import("../services/fileManagerJobs.js");
const { planZip, streamZip } = await import("../services/fileManagerZip.js");
const { hashEtag } = await import("../services/fileManagerTextCodec.js");
const { FmError, FM_LIMITS } = await import("../services/fileManagerContract.js");

const CASE_RENAME_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "caseRenameChild.mjs");

let base;
let tree;
let root;

async function codeOf(promise) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FmError) return err.code;
    return `raw:${err?.code || err?.name}`;
  }
  return "ok";
}

function osError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

const at = (...parts) => path.join(tree.data, ...parts);
const resolve = (rel, intent = "read") => localBackend.resolve(root, rel ? rel.split("/") : [], intent);

// Patch the fs module object fs.WriteStream and the fd copy call into, so the
// write that carries the LAST byte of a file fails the way a quota, a full
// disk or a network share reports it at the end.
function failFinalWrite(total, code = "ENOSPC") {
  const origWrite = fs.write;
  const origWritev = fs.writev;
  const written = new Map();
  let armed = true;
  fs.write = function (fd, buffer, offset, length, position, callback) {
    const cb = typeof callback === "function" ? callback : arguments[arguments.length - 1];
    const before = written.get(fd) || 0;
    if (typeof length === "number") written.set(fd, before + length);
    if (armed && typeof length === "number" && before + length >= total) {
      armed = false;
      setTimeout(() => cb(osError(code)), 5);
      return undefined;
    }
    return origWrite.apply(fs, arguments);
  };
  fs.writev = function (fd, buffers, position, cb) {
    const length = buffers.reduce((n, b) => n + b.length, 0);
    const before = written.get(fd) || 0;
    written.set(fd, before + length);
    if (armed && before + length >= total) {
      armed = false;
      setTimeout(() => cb(osError(code)), 5);
      return undefined;
    }
    return origWritev.apply(fs, arguments);
  };
  return () => {
    fs.write = origWrite;
    fs.writev = origWritev;
  };
}

// Record every close of an fd whose file name matches `re`.
function traceCloses(re) {
  const origOpenSync = fs.openSync;
  const origClose = fs.close;
  const origCloseSync = fs.closeSync;
  const watched = new Set();
  const closes = [];
  fs.openSync = function (p, ...rest) {
    // codeql[js/path-injection] test-only fs.openSync spy: it forwards whatever path the code under test opens inside this test's own mkdtemp root, unchanged.
    const fd = origOpenSync.call(fs, p, ...rest);
    if (re.test(String(p))) watched.add(fd);
    return fd;
  };
  fs.close = function (fd, cb) {
    if (watched.has(fd)) closes.push(fd);
    return origClose.call(fs, fd, cb);
  };
  fs.closeSync = function (fd) {
    if (watched.has(fd)) closes.push(fd);
    return origCloseSync.call(fs, fd);
  };
  return {
    watched,
    closes,
    restore() {
      fs.openSync = origOpenSync;
      fs.close = origClose;
      fs.closeSync = origCloseSync;
    },
  };
}

beforeEach(async () => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  for (const key of Object.keys(hooks)) delete hooks[key];
  invalidateRootCache();
  _setRunStateDepsForTests({});
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
  root = await localBackend.describeRoot({ id: "data", path: tree.data });
});

afterEach(() => {
  for (const key of Object.keys(hooks)) delete hooks[key];
  removeDir(base);
});

describe("uploads that fail at the very end", () => {
  it("a write refused at the end fails the upload, and nothing lands", async () => {
    const body = Buffer.from("PublicName=My server\nMaxPlayers=32\n".repeat(20));
    const restore = failFinalWrite(body.length);
    try {
      const dir = await resolve("Server", "list");
      const code = await codeOf(
        localBackend.receiveUpload(dir, "fresh.ini", Readable.from([body]), { declaredSize: body.length, maxBytes: 1e9, overwriteEtag: null, trashMeta: {} }),
      );
      expect(code).toBe("FM_INSUFFICIENT_SPACE");
    } finally {
      restore();
    }
    expect(fs.existsSync(at("Server", "fresh.ini"))).toBe(false);
    expect(fs.readdirSync(at("Server")).some((n) => n.endsWith(".zcpupload"))).toBe(false);
  });

  it("a 4 MiB upload whose last chunk fails never lands short", async () => {
    const chunks = [0, 1, 2, 3].map((i) => Buffer.alloc(1 << 20, 65 + i));
    const restore = failFinalWrite(4 << 20, "EIO");
    const source = new PassThrough({ highWaterMark: 1 << 20 });
    try {
      const dir = await resolve("", "list");
      const pending = codeOf(localBackend.receiveUpload(dir, "world.bin", source, { declaredSize: 4 << 20, maxBytes: 1e9, overwriteEtag: null, trashMeta: {} }));
      for (const chunk of chunks) source.write(chunk);
      source.end();
      expect(await pending).not.toBe("ok");
    } finally {
      restore();
    }
    expect(fs.existsSync(at("world.bin"))).toBe(false);
  });

  it("Replace by upload keeps the live file when the replacement's last write fails", async () => {
    write(at("live.ini"), "PublicName=Good\n");
    const etag = (await localBackend.stat(await resolve("live.ini"))).etag;
    const body = Buffer.from("PublicName=Better\n");
    const restore = failFinalWrite(body.length);
    try {
      const dir = await resolve("", "list");
      expect(
        await codeOf(localBackend.receiveUpload(dir, "live.ini", Readable.from([body]), { declaredSize: body.length, maxBytes: 1e9, overwriteEtag: etag, trashMeta: {} })),
      ).toBe("FM_INSUFFICIENT_SPACE");
    } finally {
      restore();
    }
    expect(fs.readFileSync(at("live.ini"), "utf8")).toBe("PublicName=Good\n");
    expect(trash.listTrash(tree.data)).toEqual([]);
  });
});

describe("one owner per file descriptor", () => {
  it("an upload cut off with writes in flight closes its temp file exactly once", async () => {
    const trace = traceCloses(/\.zcpupload$/);
    const origWrite = fs.write;
    // Slow writes, so several are still in flight when the client goes.
    fs.write = function (...args) {
      const cb = args[args.length - 1];
      args[args.length - 1] = (...result) => setTimeout(() => cb(...result), 30);
      return origWrite.apply(fs, args);
    };
    try {
      const source = new PassThrough();
      const dir = await resolve("", "list");
      const pending = codeOf(localBackend.receiveUpload(dir, "a.bin", source, { declaredSize: 64 << 20, maxBytes: 1e12, overwriteEtag: null, trashMeta: {} }));
      for (let i = 0; i < 4; i++) source.write(Buffer.alloc(1 << 20, 1));
      await new Promise((r) => setImmediate(r));
      source.emit("aborted");
      expect(await pending).toBe("FM_UPLOAD_SIZE_MISMATCH");
      // Anything a destroyed stream would still close happens after the
      // write in flight returns.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      fs.write = origWrite;
      trace.restore();
    }
    expect(trace.watched.size).toBe(1);
    expect(trace.closes).toHaveLength(1);
  });

  it("a duplicate whose copy fails closes the source and the temp file exactly once each", async () => {
    write(at("src.bin"), Buffer.alloc(3 << 20, 3));
    const trace = traceCloses(/(\.zcptmp|src\.bin)$/);
    const origWrite = fs.write;
    fs.write = function (fd, ...rest) {
      if (trace.watched.has(fd)) {
        const cb = rest[rest.length - 1];
        setTimeout(() => cb(osError("EIO")), 5);
        return undefined;
      }
      return origWrite.call(fs, fd, ...rest);
    };
    try {
      expect(await codeOf(localBackend.copyFile(await resolve("src.bin"), await resolve("", "list"), "dup.bin"))).not.toBe("ok");
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      fs.write = origWrite;
      trace.restore();
    }
    expect(trace.watched.size).toBe(2);
    expect(trace.closes.sort()).toEqual([...trace.watched].sort());
    expect(fs.existsSync(at("dup.bin"))).toBe(false);
  });
});

describe("temp files that can't be created", () => {
  it("are a permission problem, not an internal error, and a duplicate leaves no source open", async () => {
    hooks.createTempFile = () => {
      throw osError("EACCES");
    };
    const live = fs.readFileSync(at("Server", "servertest.ini"));
    const trace = traceCloses(/servertest\.ini$/);
    try {
      const dir = await resolve("Server", "list");
      expect(await codeOf(localBackend.copyFile(await resolve("Server/servertest.ini"), dir, "copy.ini"))).toBe("FM_OS_PERMISSION_DENIED");
      expect(trace.watched.size).toBe(1);
      expect(trace.closes).toHaveLength(1);
      expect(await codeOf(localBackend.receiveUpload(dir, "u.txt", Readable.from([Buffer.from("x")]), { declaredSize: 1, maxBytes: 10, overwriteEtag: null, trashMeta: {} }))).toBe(
        "FM_OS_PERMISSION_DENIED",
      );
      expect(await codeOf(localBackend.writeBytesCas(await resolve("Server/new.txt", "create"), Buffer.from("x"), { expectedHash: null, trashMeta: {} }))).toBe(
        "FM_OS_PERMISSION_DENIED",
      );
      expect(
        await codeOf(localBackend.writeBytesCas(await resolve("Server/servertest.ini", "write"), Buffer.from("x"), { expectedHash: hashEtag(live), trashMeta: {} })),
      ).toBe("FM_OS_PERMISSION_DENIED");
      // ... and the save that couldn't happen kept no "edited" version.
      expect(trash.listTrash(tree.data)).toEqual([]);
    } finally {
      trace.restore();
    }
  });

  it("EPERM creating something is the folder's permissions (Windows reports access denied that way)", async () => {
    hooks.createTempFile = () => {
      throw osError("EPERM");
    };
    hooks.mkdirPath = () => {
      throw osError("EPERM");
    };
    const dir = await resolve("Server", "list");
    expect(await codeOf(localBackend.mkdir(dir, "sub"))).toBe("FM_OS_PERMISSION_DENIED");
    expect(await codeOf(localBackend.receiveUpload(dir, "u.txt", Readable.from([Buffer.from("x")]), { declaredSize: 1, maxBytes: 10, overwriteEtag: null, trashMeta: {} }))).toBe(
      "FM_OS_PERMISSION_DENIED",
    );
  });

  it.skipIf(!IS_WIN)("a rename's EPERM is a permission problem when the folder can't even take a new file, else a file in use", async () => {
    hooks.renamePath = () => {
      throw osError("EPERM");
    };
    hooks.createTempFile = () => {
      throw osError("EPERM");
    };
    expect(await codeOf(localBackend.rename(await resolve("Logs/server.txt", "rename"), "other.txt"))).toBe("FM_OS_PERMISSION_DENIED");
    delete hooks.createTempFile;
    expect(await codeOf(localBackend.rename(await resolve("Logs/server.txt", "rename"), "other.txt"))).toBe("FM_FILE_IN_USE");
  });

  it.skipIf(!IS_WIN)("a root the panel's account can't create files in is described read-only (Windows only checks the attribute)", async () => {
    hooks.createTempFile = (actual, dir, ...rest) => {
      if (dir === tree.data) throw osError("EPERM");
      return actual(dir, ...rest);
    };
    const described = await localBackend.describeRoot({ id: "data", path: tree.data });
    expect(described).toMatchObject({ available: true, writable: false, readOnlyReason: "permissions" });
  });
});

describe("a save whose last step fails", () => {
  it("keeps no 'edited' version behind, so retries can't push real versions out", async () => {
    const rel = "Server/servertest_SandboxVars.lua";
    const file = at("Server", "servertest_SandboxVars.lua");
    const save = async (content) => {
      const current = fs.readFileSync(file);
      return localBackend.writeBytesCas(await resolve(rel, "write"), Buffer.from(content), { expectedHash: hashEtag(current), trashMeta: {} });
    };
    await save("SandboxVars = { v = 1 }\n");
    expect(trash.listTrash(tree.data)).toHaveLength(1);
    const genuine = trash.listTrash(tree.data)[0].trashId;
    hooks.renamePath = (actual, from, to) => {
      if (from.endsWith(".zcptmp")) throw osError("EBUSY");
      return actual(from, to);
    };
    for (let i = 0; i < 25; i++) expect(await codeOf(save(`SandboxVars = { v = 2, try = ${i} }\n`))).toBe("FM_FILE_IN_USE");
    delete hooks.renamePath;
    expect(trash.listTrash(tree.data).map((item) => item.trashId)).toEqual([genuine]);
    await save("SandboxVars = { v = 3 }\n");
    expect(trash.listTrash(tree.data).map((item) => item.trashId)).toContain(genuine);
    expect(fs.readdirSync(at("Server")).some((n) => n.endsWith(".zcptmp"))).toBe(false);
  });
});

describe("Trash", () => {
  async function trashed(rel) {
    return (await localBackend.trashMove(await resolve(rel, "delete"), { deletedBy: { username: "kate" } })).trashId;
  }

  it("a purge that stops partway leaves the item listed, and purging it again finishes the job", async () => {
    for (let i = 0; i < 5; i++) write(at("old", "sub", `f${i}.bin`), "x");
    const trashId = await trashed("old");
    let failure;
    try {
      await trash.purgeTrashItem(tree.data, trashId, { maxEntries: 2 });
    } catch (err) {
      failure = err;
    }
    // The entry cap is its own code, not "unexpected error".
    expect(mapFsError(failure)).toMatchObject({ code: "FM_TOO_MANY_ENTRIES", params: { limit: FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES } });
    expect(trash.listTrash(tree.data).map((item) => item.trashId)).toEqual([trashId]);
    await localBackend.deletePermanent({ root, trashId });
    expect(trash.countTrashItems(tree.data)).toBe(0);
    expect(fs.existsSync(path.join(trash.trashDirOf(tree.data), trashId))).toBe(false);
  });

  it("a payload folder planted as a link is never read or restored through", async () => {
    const outside = path.join(base, "outside-folder");
    write(path.join(outside, "db.json"), '{"jwtSecret":"outside-the-root"}');
    const itemDir = path.join(tree.data, ".zcp-trash", "20260930T000000Z-deadbeef");
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(path.join(itemDir, "meta.json"), JSON.stringify({ v: 1, originalPath: "notes.txt", type: "file", bytes: 1, files: 1, reason: "edited" }));
    linkDir(outside, path.join(itemDir, "payload"));
    expect(await codeOf(localBackend.trashReadBytes(root, "20260930T000000Z-deadbeef", { maxBytes: 1000 }))).toBe("FM_TRASH_ITEM_NOT_FOUND");
    expect(await codeOf(localBackend.trashRestore(root, "20260930T000000Z-deadbeef"))).toBe("FM_TRASH_ITEM_NOT_FOUND");
    expect(fs.readFileSync(path.join(outside, "db.json"), "utf8")).toContain("outside-the-root");
    expect(fs.existsSync(at("notes.txt"))).toBe(false);
  });

  it("an item whose meta.json can't be written is refused before anything moves", async () => {
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (p, ...rest) {
      if (String(p).endsWith("meta.json")) throw osError("ENOSPC");
      // codeql[js/path-injection, js/insecure-temporary-file] test-only fs.writeFileSync spy: it forwards the backend's own writes inside this test's mkdtemp root, unchanged.
      return realWrite.call(fs, p, ...rest);
    };
    let deleteCode;
    let replaceCode;
    try {
      deleteCode = await codeOf(trashed("Logs/server.txt"));
      write(at("keep.ini"), "OLD=1\n");
      const etag = (await localBackend.stat(await resolve("keep.ini"))).etag;
      replaceCode = await codeOf(
        localBackend.receiveUpload(await resolve("", "list"), "keep.ini", Readable.from([Buffer.from("NEW=1\n")]), { declaredSize: 6, maxBytes: 100, overwriteEtag: etag, trashMeta: {} }),
      );
    } finally {
      fs.writeFileSync = realWrite;
    }
    expect(deleteCode).toBe("FM_TRASH_UNAVAILABLE");
    expect(fs.existsSync(at("Logs", "server.txt"))).toBe(true);
    expect(replaceCode).toBe("FM_TRASH_UNAVAILABLE");
    expect(fs.readFileSync(at("keep.ini"), "utf8")).toBe("OLD=1\n");
    expect(trash.countTrashItems(tree.data)).toBe(0);
  });
});

describe("renames", () => {
  it.skipIf(!IS_WIN)("a rename JavaScript thinks is case-only never replaces a DIFFERENT file (NTFS keeps ß and ẞ apart)", async () => {
    write(at("ẞ.txt"), "selected file");
    write(at("ß.txt"), "the other file, never selected");
    expect(await codeOf(localBackend.rename(await resolve("ẞ.txt", "rename"), "ß.txt"))).toBe("FM_EXISTS");
    expect(fs.readFileSync(at("ß.txt"), "utf8")).toBe("the other file, never selected");
    expect(fs.readFileSync(at("ẞ.txt"), "utf8")).toBe("selected file");
  });

  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")("a real case-only rename still works", async () => {
    write(at("notes.txt"), "mine");
    const entry = await localBackend.rename(await resolve("notes.txt", "rename"), "NOTES.TXT");
    expect(entry.name).toBe("NOTES.TXT");
    expect(fs.readdirSync(tree.data)).toContain("NOTES.TXT");
  });

  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "a case-only rename that fails halfway never leaves the file where the orphan sweep deletes it after a restart",
    async () => {
      const file = write(at("notes.txt"), "the admin's notes");
      const lastWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      fs.utimesSync(file, lastWeek, lastWeek);
      // In another process, which then exits: every rename away from the
      // temp name fails (the second step, the rollback, the recovery name).
      const out = execFileSync(process.execPath, [CASE_RENAME_CHILD, tree.data, "notes.txt", "NOTES.TXT"], { encoding: "utf8" });
      expect(JSON.parse(/@@result (.*)/.exec(out)[1]).code).toBe("FM_FILE_IN_USE");
      // The next panel sweeps the folder on its next write into it.
      sweepOrphanTemps(tree.data, Date.now() + 24 * 3600 * 1000);
      const left = fs.readdirSync(tree.data).filter((n) => n.toLowerCase().includes("notes"));
      expect(left).toHaveLength(1);
      expect(fs.readFileSync(path.join(tree.data, left[0]), "utf8")).toBe("the admin's notes");
    },
  );

  it("after a failed case-only step the file is put back under its own name", async () => {
    write(at("notes.txt"), "mine");
    let calls = 0;
    hooks.renamePath = (actual, from, to) => {
      calls++;
      if (calls === 2) throw osError("EBUSY");
      return actual(from, to);
    };
    const r = await resolve("notes.txt", "rename");
    // Only a case-folding filesystem finds NOTES.TXT to be the same file.
    if (!fs.existsSync(at("NOTES.TXT"))) return;
    expect(await codeOf(localBackend.rename(r, "NOTES.TXT"))).toBe("FM_FILE_IN_USE");
    expect(fs.readdirSync(tree.data)).toContain("notes.txt");
  });
});

describe("filesystems without hard links (FAT32/exFAT on Windows report EISDIR)", () => {
  it("new files, uploads, duplicates and restores still land", async () => {
    hooks.linkPath = () => {
      throw osError("EISDIR");
    };
    const dir = await resolve("Server", "list");
    expect(await codeOf(localBackend.writeBytesCas(await resolve("Server/new.txt", "create"), Buffer.from("n"), { expectedHash: null, trashMeta: {} }))).toBe("ok");
    expect(await codeOf(localBackend.receiveUpload(dir, "up.txt", Readable.from([Buffer.from("u")]), { declaredSize: 1, maxBytes: 10, overwriteEtag: null, trashMeta: {} }))).toBe("ok");
    expect(await codeOf(localBackend.copyFile(await resolve("Server/new.txt"), dir, "dup.txt"))).toBe("ok");
    const trashId = (await localBackend.trashMove(await resolve("Server/up.txt", "delete"), {})).trashId;
    expect(await codeOf(localBackend.trashRestore(root, trashId))).toBe("ok");
    for (const name of ["new.txt", "up.txt", "dup.txt"]) expect(fs.existsSync(at("Server", name)), name).toBe(true);
  });
});

describe("walks that meet something they can't read", () => {
  it("a zip of a folder with an unlistable subfolder says so in _skipped.txt", async () => {
    write(at("Saves", "Multiplayer", "servertest", "map_1_1.bin"), "chunk");
    write(at("Saves", "readme.txt"), "hi");
    hooks.readDirEntries = (actual, dir, ...rest) => {
      if (String(dir).endsWith(path.join("Saves", "Multiplayer"))) throw osError("EPERM");
      return actual(dir, ...rest);
    };
    const item = await resolve("Saves");
    const plan = await planZip({ backend: localBackend, items: [item], classify: () => null });
    expect(plan.skipped).toContainEqual({ name: "Saves/Multiplayer/", reason: "unreadable folder" });
    const res = new PassThrough();
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    await streamZip({ res, backend: localBackend, root, plan });
    expect(Buffer.concat(chunks).toString("latin1")).toContain("_skipped.txt");
    // The delete preview's counts are then only a floor.
    const ctx = await service.loadProfileContext(tree.profile.id, { get: () => undefined });
    const preview = await service.deletePreview(ctx, { root: "data", paths: ["Saves"] }, { userId: "u1" });
    expect(preview.items[0].truncated).toBe(true);
  });
});

describe("names that aren't valid Unicode", () => {
  // Windows: an unpaired UTF-16 surrogate (WTF-8 bytes ED A0 80); Linux:
  // Latin-1 bytes from an old unzip. macOS refuses both, so it is skipped.
  const badName = Buffer.concat([
    Buffer.from("Tradu"),
    IS_WIN ? Buffer.from([0xed, 0xa0, 0x80]) : Buffer.from([0xe7, 0xe3]),
    Buffer.from("o.txt"),
  ]);
  const makeBad = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(Buffer.concat([Buffer.from(dir), Buffer.from(path.sep), badName]), "bad name");
    fs.writeFileSync(path.join(dir, "ok.txt"), "ok");
  };

  it.skipIf(process.platform === "darwin")("are listed (not openable), and never stop a delete or a Trash purge", async () => {
    makeBad(at("mods", "broken"));
    const listed = await localBackend.list(await resolve("mods/broken", "list"), {});
    expect(listed.entries).toHaveLength(2);
    expect(listed.entries.find((e) => e.name !== "ok.txt").unrepresentable).toBe(true);
    const trashId = (await localBackend.trashMove(await resolve("mods", "delete"), {})).trashId;
    await localBackend.deletePermanent({ root, trashId });
    expect(fs.existsSync(path.join(trash.trashDirOf(tree.data), trashId))).toBe(false);
    makeBad(at("Logs2"));
    await localBackend.deletePermanent(await resolve("Logs2", "delete"));
    expect(fs.existsSync(at("Logs2"))).toBe(false);
  });
});

describe("a folder that keeps filling while it is deleted", () => {
  it("is emptied again instead of failing as 'name already there'", async () => {
    for (let i = 0; i < 450; i++) write(at("Logs", "many", `f${i}.txt`), "x");
    const r = await resolve("Logs/many", "delete");
    let added = false;
    await localBackend.deletePermanent(r, (done) => {
      if (!added && done >= 200) {
        added = true;
        write(at("Logs", "many", "late.txt"), "written by the running server");
      }
    });
    expect(added).toBe(true);
    expect(fs.existsSync(at("Logs", "many"))).toBe(false);
  });

  it("maps a folder that never stops filling to 'in use', never FM_EXISTS with an empty name", () => {
    expect(mapFsError(osError("ENOTEMPTY"), { deleting: true }).code).toBe("FM_FILE_IN_USE");
    expect(mapFsError(osError("ENOTEMPTY"), { name: "x" })).toMatchObject({ code: "FM_EXISTS", params: { name: "x" } });
  });
});

describe("Windows read-only attribute", () => {
  it.skipIf(!IS_WIN)("Duplicate over a read-only file is refused like an upload over it", async () => {
    const target = write(at("Server", "locked.ini"), "PublicName=admin locked this\n");
    fs.chmodSync(target, 0o444);
    try {
      const etag = (await localBackend.stat(await resolve("Server/locked.ini"))).etag;
      const code = await codeOf(
        localBackend.copyFile(await resolve("Server/servertest.ini"), await resolve("Server", "list"), "locked.ini", { overwriteEtag: etag, trashMeta: {} }),
      );
      expect(code).toBe("FM_TARGET_READ_ONLY");
      expect(fs.readFileSync(target, "utf8")).toBe("PublicName=admin locked this\n");
      expect(fs.statSync(target).mode & 0o200).toBe(0);
    } finally {
      fs.chmodSync(target, 0o666);
    }
  });
});
