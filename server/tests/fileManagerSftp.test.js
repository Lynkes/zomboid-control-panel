import crypto from "crypto";
import { PassThrough, Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// The config-mirror lock and session reset are real, wrapped in spies, so a
// test can see a write under Server/ take the lock and drop the session.
vi.mock("../services/remoteConfigFiles.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acquireMirrorLock: vi.fn(actual.acquireMirrorLock),
    resetRemoteConfigSession: vi.fn(actual.resetRemoteConfigSession),
  };
});

const { acquireMirrorLock, resetRemoteConfigSession } = await import("../services/remoteConfigFiles.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { FM_LIMITS, FmError, TRASH_ID_RE } = await import("../services/fileManagerContract.js");
const { createSftpBackend, closeFileManagerSftpPool } = await import("../services/fileManagerSftpBackend.js");
const { getFileManagerSftpPool, _setFileManagerSftpTestHooks, toFmError } = await import(
  "../services/fileManagerSftpPool.js"
);
const { FakeSftpServer, createFakeSftpFixture } = await import("./helpers/fakeSftp.js");

const ROOT = "/srv/pz/Zomboid";
const OUTSIDE = "/srv/secret";
const CANARY = "CANARY-7f3a9c-outside-the-root";

let fixtures = [];

async function setup(options = {}) {
  const fixture = await createFakeSftpFixture({ rootPath: ROOT, ...options });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
  await closeFileManagerSftpPool();
  _setFileManagerSftpTestHooks();
  vi.clearAllMocks();
});

async function expectFm(promise, code, params) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(FmError);
  expect(caught.code).toBe(code);
  if (params) expect(caught.params).toMatchObject(params);
  return caught;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function drain(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function tempNames(server, dir) {
  return server.childNames(dir).filter((name) => /\.zcp(upload|tmp)$/.test(name));
}

async function resolveRel(f, rel, intent = "read") {
  return f.backend.resolve(f.root, rel ? rel.split("/") : [], intent);
}

// ============================================
// Pool
// ============================================

describe("SFTP pool", () => {
  it("reuses one pool per login and gives a changed password a new pool, closing the old one", async () => {
    const server = new FakeSftpServer();
    server.mkdirp(ROOT);
    _setFileManagerSftpTestHooks({ clientFactory: server.clientFactory });
    const settings = {
      panelBridgeSftpHost: "sftp.test",
      panelBridgeSftpPort: 22,
      panelBridgeSftpUsername: "pz",
      panelBridgeSftpPassword: "first",
    };
    const first = getFileManagerSftpPool(settings);
    expect(getFileManagerSftpPool({ ...settings })).toBe(first);
    await first.run((c) => c.list(ROOT));
    expect(server.connects).toBe(1);

    const second = getFileManagerSftpPool({ ...settings, panelBridgeSftpPassword: "second" });
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(server.ends).toBe(1));
    await expectFm(first.run((c) => c.list(ROOT)), ErrorCode.FM_ROOT_UNAVAILABLE);
    await second.run((c) => c.list(ROOT));
    expect(server.connects).toBe(2);
  });

  it("refuses without a usable login", () => {
    for (const settings of [
      {},
      { panelBridgeSftpHost: "sftp.test" },
      { panelBridgeSftpHost: "bad host", panelBridgeSftpUsername: "pz" },
      { panelBridgeSftpHost: "sftp.test", panelBridgeSftpUsername: "pz", panelBridgeSftpPort: 70000 },
    ]) {
      let caught;
      try {
        createSftpBackend({ settings });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FmError);
      expect(caught.code).toBe(ErrorCode.FM_ROOT_UNAVAILABLE);
      expect(caught.params).toEqual({ reason: "remoteNotConfigured" });
    }
  });

  it("drops a client that times out and opens a fresh one for the next call", async () => {
    const f = await setup({ timeouts: { opMs: 40 } });
    const pool = getFileManagerSftpPool(f.settings);
    const connectsBefore = f.server.connects;
    f.server.inject("list", { hang: true });
    await expectFm(pool.run((c) => c.list(ROOT), { retry: true }), ErrorCode.FM_SFTP_TIMEOUT);
    await vi.waitFor(() => expect(f.server.ends).toBe(1));
    const listed = await pool.run((c) => c.list(ROOT));
    expect(Array.isArray(listed)).toBe(true);
    expect(f.server.connects).toBe(connectsBefore + 1);
  });

  it("retries only idempotent reads, once, after the connection drops", async () => {
    const f = await setup();
    f.seed.file("a.txt", "a");
    f.server.clearLog();

    // A read: reconnects and succeeds.
    f.server.inject("list", { connectionLost: true });
    const entries = await f.backend.list(await resolveRel(f, ""), {});
    expect(entries.entries.map((e) => e.name)).toEqual(["a.txt"]);
    expect(f.server.opCount("list")).toBe(2);

    // A write: the same failure is reported, never replayed.
    const target = await resolveRel(f, "a.txt", "rename");
    f.server.clearLog();
    f.server.inject("rename", { connectionLost: true });
    const err = await expectFm(f.backend.rename(target, "b.txt"), ErrorCode.FM_SFTP_ERROR);
    expect(err.params.sftpCode).toBeDefined();
    expect(f.server.opCount("rename")).toBe(1);
    expect(f.exists("a.txt")).toBe(true);
    expect(f.exists("b.txt")).toBe(false);

    // A second drop right after the retry is not retried again.
    f.server.inject("list", { connectionLost: true, times: 2 });
    f.server.clearLog();
    await expectFm(f.backend.list(await resolveRel(f, ""), {}), ErrorCode.FM_SFTP_ERROR);
    expect(f.server.opCount("list")).toBe(2);
  });

  it("closes connections after the idle limit", async () => {
    const f = await setup({ timeouts: { idleCloseMs: 30 } });
    const pool = getFileManagerSftpPool(f.settings);
    await pool.run((c) => c.list(ROOT));
    expect(pool.openClients).toBe(1);
    await vi.waitFor(() => expect(pool.openClients).toBe(0), { timeout: 2000, interval: 10 });
    expect(f.server.ends).toBeGreaterThanOrEqual(1);
  });

  it("opens at most one metadata and two transfer connections", async () => {
    const f = await setup();
    f.seed.file("big.bin", Buffer.alloc(4096, 1));
    f.server.stallReads = true;
    const pool = getFileManagerSftpPool(f.settings);
    const r = await resolveRel(f, "big.bin");
    const streams = [];
    for (let i = 0; i < 4; i++) streams.push(await f.backend.openReadStream(r));
    expect(pool.openClients).toBe(3);
    expect(f.server.connects).toBe(3);
    for (const s of streams) await s.close();
  });

  it("maps SFTP failures without leaking paths or the password", async () => {
    const notFound = toFmError(Object.assign(new Error("list: No such file /srv/pz/x"), { code: 2 }));
    expect(notFound.code).toBe(ErrorCode.FM_NOT_FOUND);
    expect(notFound.params).toEqual({});

    const denied = toFmError(Object.assign(new Error("_rename: Permission denied /srv/pz/x"), { code: 3 }));
    expect(denied.code).toBe(ErrorCode.FM_OS_PERMISSION_DENIED);
    expect(denied.params).toEqual({ detail: "EACCES" });

    const failure = toFmError(Object.assign(new Error("_rename: Failure From: /srv/a To: /srv/b"), { code: 4 }));
    expect(failure.code).toBe(ErrorCode.FM_SFTP_ERROR);
    expect(failure.params).toEqual({ sftpCode: ErrorCode.SFTP_UNKNOWN, detail: "FAILURE" });
    expect(failure.message).toBe(ErrorCode.FM_SFTP_ERROR);
    expect(JSON.stringify(failure)).not.toContain("/srv");

    const refused = toFmError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:22"), { code: "ECONNREFUSED" }));
    expect(refused.params).toEqual({ sftpCode: ErrorCode.SFTP_UNREACHABLE, detail: "ECONNREFUSED" });

    const odd = toFmError(Object.assign(new Error("weird /srv/pz"), { code: "some/path" }));
    expect(odd.params.detail).toBe("UNKNOWN");
  });

  it("reports a wrong password as an SFTP auth failure and never echoes it", async () => {
    const f = await setup({ server: { password: "right-password" }, settings: { panelBridgeSftpPassword: "wrong-password" } });
    expect(f.root.available).toBe(false);
    expect(f.root.unavailableReason).toBe("sftpUnreachable");
    expect(f.root.unavailableDetail).toBe(ErrorCode.SFTP_AUTH_FAILED);
    const err = await expectFm(
      f.backend.resolve({ id: "data", available: true, real: ROOT }, [], "list"),
      ErrorCode.FM_SFTP_ERROR,
      { sftpCode: ErrorCode.SFTP_AUTH_FAILED },
    );
    expect(JSON.stringify({ ...err, params: err.params, root: f.root })).not.toContain("password");
  });

  it("passes the 10 s ready timeout to connect()", async () => {
    const f = await setup();
    expect(f.server.lastConnect).toMatchObject({ host: "sftp.test", port: 2222, username: "pz", readyTimeout: 10000 });
  });
});

// ============================================
// describeRoot and freeSpace
// ============================================

describe("describeRoot", () => {
  it("describes an available root with its real path, space and Trash count", async () => {
    const f = await setup();
    expect(f.root).toMatchObject({
      id: "data",
      backend: "sftp",
      displayPath: ROOT,
      available: true,
      real: ROOT,
      writable: null,
      freeBytes: 250000 * 4096,
      totalBytes: 1000000 * 4096,
      warnings: [],
      trashItemCount: 0,
    });
  });

  it("uses the server's real path for a root reached through a link", async () => {
    const f = await setup();
    f.server.mkdirp("/data/real-zomboid");
    f.server.symlink("/home/pz/Zomboid", "/data/real-zomboid");
    const root = await f.backend.describeRoot({ id: "data", path: "/home/pz/Zomboid", warnings: ["remoteFilesystemRoot"] });
    expect(root).toMatchObject({ available: true, real: "/data/real-zomboid", displayPath: "/home/pz/Zomboid" });
    expect(root.warnings).toEqual(["remoteFilesystemRoot"]);
  });

  it("reports missing folders, files and unreachable hosts", async () => {
    const f = await setup();
    f.server.writeFile("/srv/file.txt", "x");
    expect(await f.backend.describeRoot({ id: "install", path: "/nope" })).toMatchObject({
      available: false,
      unavailableReason: "missing",
      real: null,
    });
    expect(await f.backend.describeRoot({ id: "install", path: "/srv/file.txt" })).toMatchObject({
      available: false,
      unavailableReason: "missing",
    });
    await closeFileManagerSftpPool();
    f.server.unreachable = true;
    const backend = createSftpBackend({ settings: f.settings });
    expect(await backend.describeRoot({ id: "data", path: ROOT })).toMatchObject({
      available: false,
      unavailableReason: "sftpUnreachable",
      unavailableDetail: ErrorCode.SFTP_UNREACHABLE,
    });
  });

  it("turns an unavailable spec into a descriptor without connecting", async () => {
    const server = new FakeSftpServer();
    _setFileManagerSftpTestHooks({ clientFactory: server.clientFactory });
    const backend = createSftpBackend({
      settings: { panelBridgeSftpHost: "sftp.test", panelBridgeSftpUsername: "pz", panelBridgeSftpPassword: "x" },
    });
    const root = await backend.describeRoot({ id: "install", path: null, warnings: [], unavailable: { reason: "remoteInstallNotSet" } });
    expect(root).toMatchObject({ id: "install", backend: "sftp", available: false, unavailableReason: "remoteInstallNotSet" });
    expect(server.connectAttempts).toBe(0);
    await expectFm(backend.resolve(root, [], "list"), ErrorCode.FM_ROOT_UNAVAILABLE, { reason: "remoteInstallNotSet" });
  });

  it("works on an explicitly chosen / root", async () => {
    const f = await createFakeSftpFixture({ rootPath: "/" });
    fixtures.push(f);
    expect(f.root).toMatchObject({ available: true, real: "/" });
    f.server.writeFile("/opt/pz/a.txt", "a");
    const r = await f.backend.resolve(f.root, ["opt", "pz", "a.txt"], "delete");
    expect(r).toMatchObject({ rel: "opt/pz/a.txt", realRel: "opt/pz/a.txt", abs: "/opt/pz/a.txt" });
    const { trashId } = await f.backend.trashMove(r, { deletedBy: {} });
    expect(f.server.exists(`/.zcp-trash/${trashId}/payload/a.txt`)).toBe(true);
    expect((await f.backend.list(await f.backend.resolve(f.root, [], "list"), {})).entries.map((e) => e.name)).toEqual(["opt"]);
    const restored = await f.backend.trashRestore(f.root, trashId);
    expect(restored).toMatchObject({ rel: "opt/pz/a.txt", realRel: "opt/pz/a.txt" });
    expect(f.server.readFile("/opt/pz/a.txt").toString()).toBe("a");
  });

  it("returns null space when the server has no statvfs extension", async () => {
    const f = await setup({ server: { statvfs: false } });
    expect(f.root.freeBytes).toBeNull();
    expect(f.root.totalBytes).toBeNull();
    expect(await f.backend.freeSpace(f.root)).toEqual({ free: null, total: null });
  });
});

// ============================================
// Resolution and links (spec §A4.5)
// ============================================

describe("resolve", () => {
  it("resolves nested paths, the root and new names", async () => {
    const f = await setup();
    f.seed.file("Server/main.ini", "a=1\n");
    const r = await resolveRel(f, "Server/main.ini");
    expect(r).toMatchObject({
      rootId: "data",
      rel: "Server/main.ini",
      realRel: "Server/main.ini",
      abs: `${ROOT}/Server/main.ini`,
      isNew: false,
      protection: null,
      worldState: false,
    });
    expect(r.stat).toMatchObject({ type: "file", size: 4, mode: 0o644, dev: null, ino: null });

    const root = await resolveRel(f, "", "list");
    expect(root).toMatchObject({ rel: "", realRel: "", abs: ROOT, isNew: false });
    expect(root.stat.type).toBe("dir");

    const created = await resolveRel(f, "Server/new.ini", "create");
    expect(created).toMatchObject({ isNew: true, stat: null, abs: `${ROOT}/Server/new.ini`, realRel: "Server/new.ini" });

    await expectFm(resolveRel(f, "Server/new.ini", "read"), ErrorCode.FM_NOT_FOUND);
    await expectFm(resolveRel(f, "Missing/new.ini", "create"), ErrorCode.FM_NOT_FOUND);
    await expectFm(resolveRel(f, "Server/main.ini/x", "read"), ErrorCode.FM_NOT_A_DIRECTORY);
  });

  it("re-validates segments and keeps Trash and temp files out of reach", async () => {
    const f = await setup();
    f.seed.dir(".zcp-trash/20260101T000000Z-abcdef01/payload");
    f.seed.file("Server/.x.1234abcd.zcpupload", "partial");
    await expectFm(f.backend.resolve(f.root, ["..", "etc"], "read"), ErrorCode.FM_INVALID_PATH, { reason: "dotSegment" });
    await expectFm(f.backend.resolve(f.root, ["a\\b"], "read"), ErrorCode.FM_INVALID_PATH, { reason: "backslash" });
    await expectFm(resolveRel(f, ".zcp-trash", "list"), ErrorCode.FM_NOT_FOUND);
    await expectFm(resolveRel(f, ".ZCP-Trash/20260101T000000Z-abcdef01", "list"), ErrorCode.FM_NOT_FOUND);
    await expectFm(resolveRel(f, "Server/.x.1234abcd.zcpupload", "read"), ErrorCode.FM_NOT_FOUND);
    await expectFm(f.backend.resolve(f.root, [], "open"), ErrorCode.FM_INVALID_REQUEST);
  });

  it("follows a link that stays inside the root", async () => {
    const f = await setup();
    f.seed.file("Saves/Multiplayer/main/map.bin", "m");
    f.seed.link("current", "Saves/Multiplayer/main");
    const r = await resolveRel(f, "current/map.bin");
    expect(r).toMatchObject({ rel: "current/map.bin", realRel: "Saves/Multiplayer/main/map.bin" });
    const dir = await resolveRel(f, "current", "list");
    expect(dir.stat.type).toBe("dir");
    const listed = await f.backend.list(dir, {});
    expect(listed.entries[0]).toMatchObject({ name: "map.bin", rel: "current/map.bin", realRel: "Saves/Multiplayer/main/map.bin" });
  });

  it("refuses links that leave the root, and the canary outside never shows up", async () => {
    const f = await setup();
    f.server.writeFile(`${OUTSIDE}/canary.txt`, CANARY);
    f.seed.link("abs-file", `${OUTSIDE}/canary.txt`);
    f.seed.link("abs-dir", OUTSIDE);
    f.seed.link("sub/rel-dir", "../../../secret");
    f.seed.link("sibling", "../Zomboid-other");
    f.server.mkdirp("/srv/pz/Zomboid-other");

    for (const rel of ["abs-file", "abs-dir", "abs-dir/canary.txt", "sub/rel-dir", "sub/rel-dir/canary.txt", "sibling"]) {
      await expectFm(resolveRel(f, rel, "read"), ErrorCode.FM_LINK_ESCAPES_ROOT);
    }

    const listing = await f.backend.list(await resolveRel(f, "", "list"), {});
    const sub = await f.backend.list(await resolveRel(f, "sub", "list"), {});
    const links = [...listing.entries, ...sub.entries].filter((e) => e.type === "link");
    expect(links.map((e) => e.link)).toEqual(links.map(() => ({ inside: false, targetType: "unknown" })));
    const everything = JSON.stringify([listing, sub, await drain(f.backend.walk(await resolveRel(f, "", "list"), {}))]);
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain("canary");
    expect(everything).not.toContain(OUTSIDE);
    // Nothing outside was ever read.
    expect(f.server.log.filter((e) => ["get", "createReadStream"].includes(e.op) && e.path?.startsWith(OUTSIDE))).toEqual([]);
  });

  it("acts on an escaping link itself for delete, rename and move", async () => {
    const f = await setup();
    f.server.writeFile(`${OUTSIDE}/canary.txt`, CANARY);
    f.seed.link("escape", OUTSIDE);
    f.seed.dir("dest");

    const forDelete = await resolveRel(f, "escape", "delete");
    expect(forDelete).toMatchObject({ abs: `${ROOT}/escape`, realRel: "escape" });
    expect(forDelete.stat.type).toBe("link");

    const renamed = await f.backend.rename(await resolveRel(f, "escape", "rename"), "escape2");
    expect(renamed).toMatchObject({ name: "escape2", type: "link", link: { inside: false, targetType: "unknown" } });
    const moved = await f.backend.move(await resolveRel(f, "escape2", "move"), await resolveRel(f, "dest", "list"));
    expect(moved.rel).toBe("dest/escape2");

    await f.backend.deletePermanent(await resolveRel(f, "dest/escape2", "delete"), () => {});
    expect(f.exists("dest/escape2")).toBe(false);
    expect(f.server.readFile(`${OUTSIDE}/canary.txt`).toString()).toBe(CANARY);
  });

  it("reports broken links and loops as not found", async () => {
    const f = await setup();
    f.seed.link("broken", "nothing-here");
    f.seed.link("loop-a", "loop-b");
    f.seed.link("loop-b", "loop-a");
    await expectFm(resolveRel(f, "broken"), ErrorCode.FM_NOT_FOUND);
    await expectFm(resolveRel(f, "loop-a"), ErrorCode.FM_NOT_FOUND);
    const listing = await f.backend.list(await resolveRel(f, "", "list"), {});
    expect(listing.entries.find((e) => e.name === "broken").link).toEqual({ inside: true, targetType: "missing" });
  });

  describe("on a server whose REALPATH doesn't resolve links (readlink fallback)", () => {
    it("refuses an absolute target outside the root", async () => {
      const f = await setup({ server: { realPathResolvesLinks: false } });
      f.server.writeFile(`${OUTSIDE}/canary.txt`, CANARY);
      f.seed.link("abs", OUTSIDE);
      await expectFm(resolveRel(f, "abs/canary.txt"), ErrorCode.FM_LINK_ESCAPES_ROOT);
      expect(f.server.opCount("readlink")).toBeGreaterThan(0);
    });

    it("refuses a relative target that climbs out", async () => {
      const f = await setup({ server: { realPathResolvesLinks: false } });
      f.server.writeFile(`${OUTSIDE}/canary.txt`, CANARY);
      f.seed.link("a/b/up", "../../../../secret/canary.txt");
      await expectFm(resolveRel(f, "a/b/up"), ErrorCode.FM_LINK_ESCAPES_ROOT);
    });

    it("follows an inside link and checks a link inside its target too", async () => {
      const f = await setup({ server: { realPathResolvesLinks: false } });
      f.seed.file("real/x.txt", "x");
      f.seed.link("alias", "real");
      const r = await resolveRel(f, "alias/x.txt");
      expect(r.realRel).toBe("real/x.txt");

      // alias2 -> hop (inside) -> an outside folder: caught at the second hop.
      f.server.mkdirp(OUTSIDE);
      f.seed.link("hop", OUTSIDE);
      f.seed.link("alias2", "hop");
      await expectFm(resolveRel(f, "alias2"), ErrorCode.FM_LINK_ESCAPES_ROOT);
    });
  });
});

// ============================================
// Listing and stat
// ============================================

describe("list and stat", () => {
  it("lists folders first with sizes, modes and stat etags, hiding Trash and temp files", async () => {
    const f = await setup();
    f.server.setClock(1_700_000_000);
    f.seed.file("b.txt", "bb", { mode: 0o600 });
    f.seed.file("a10.txt", "a");
    f.seed.file("a9.txt", "aaa");
    f.seed.file("start-server.sh", "#!/bin/sh\n", { mode: 0o4755 });
    f.seed.dir("Server");
    f.seed.dir(".zcp-trash");
    f.seed.file(".b.txt.deadbeef.zcpupload", "partial");
    f.seed.file("Server/.x.cafebabe.zcptmp", "tmp");
    const dir = await resolveRel(f, "", "list");
    const out = await f.backend.list(dir, { offset: 0, limit: 500, sort: "name", order: "asc" });
    expect(out.entries.map((e) => e.name)).toEqual(["Server", "a9.txt", "a10.txt", "b.txt", "start-server.sh"]);
    expect(out).toMatchObject({ total: 5, sortLimited: false, truncated: false });
    expect(out.dirEtag).toMatch(/^d:\d+-5-[0-9a-f]{16}$/);
    const b = out.entries.find((e) => e.name === "b.txt");
    expect(b).toEqual({
      name: "b.txt",
      rel: "b.txt",
      realRel: "b.txt",
      type: "file",
      size: 2,
      mtimeMs: 1_700_000_000_000,
      mode: 0o600,
      dev: null,
      ino: null,
      etag: "s:2-1700000000000",
    });
    expect(out.entries.find((e) => e.name === "start-server.sh").mode).toBe(0o4755);
    expect(out.entries[0]).toMatchObject({ type: "dir", size: null, etag: null });

    const inner = await f.backend.list(await resolveRel(f, "Server", "list"), {});
    expect(inner.entries).toEqual([]);
  });

  it("sorts by size and date, both ways, and pages", async () => {
    const f = await setup();
    f.seed.file("small", "1", { mtime: 300 });
    f.seed.file("large", "12345", { mtime: 100 });
    f.seed.file("medium", "123", { mtime: 200 });
    const dir = await resolveRel(f, "", "list");
    const names = async (opts) => (await f.backend.list(dir, opts)).entries.map((e) => e.name);
    expect(await names({ sort: "size", order: "asc" })).toEqual(["small", "medium", "large"]);
    expect(await names({ sort: "size", order: "desc" })).toEqual(["large", "medium", "small"]);
    expect(await names({ sort: "modified", order: "asc" })).toEqual(["large", "medium", "small"]);
    expect(await names({ sort: "name", order: "desc" })).toEqual(["small", "medium", "large"]);
    const page = await f.backend.list(dir, { offset: 1, limit: 1, sort: "name", order: "asc" });
    expect(page.entries.map((e) => e.name)).toEqual(["medium"]);
    expect(page.total).toBe(3);
  });

  it("changes the folder etag when a same-second change adds a name", async () => {
    const f = await setup();
    f.server.setClock(1_700_000_000);
    f.seed.file("one", "1");
    const dir = await resolveRel(f, "", "list");
    const before = (await f.backend.list(dir, {})).dirEtag;
    f.seed.file("two", "2");
    const after = (await f.backend.list(await resolveRel(f, "", "list"), {})).dirEtag;
    expect(after).not.toBe(before);
  });

  it("sorts a folder over 2,000 entries by name only", async () => {
    const f = await setup();
    for (let i = 0; i < FM_LIMITS.LIST_FULL_STAT_MAX + 1; i++) f.seed.file(`big/f${i}`, i % 2 ? "xx" : "x");
    const out = await f.backend.list(await resolveRel(f, "big", "list"), { sort: "size", order: "asc", limit: 3 });
    expect(out.sortLimited).toBe(true);
    expect(out.total).toBe(FM_LIMITS.LIST_FULL_STAT_MAX + 1);
    expect(out.entries.map((e) => e.name)).toEqual(["f0", "f1", "f2"]);
  });

  it("reads a folder to its end even when a READDIR reply holds only '.' and '..'", async () => {
    // ssh2 drops those two from a reply; a reply of nothing else came back
    // empty and ended the listing, so the folder looked empty, a search
    // skipped it and a permanent delete failed on a folder it thought empty.
    const f = await setup({ server: { readdirBatch: 2 } });
    for (let i = 0; i < 5; i++) f.seed.file(`d/f${i}.txt`, "x");
    const listed = await f.backend.list(await resolveRel(f, "d", "list"), {});
    expect(listed.entries.map((e) => e.name)).toEqual(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
    expect((await drain(f.backend.walk(await resolveRel(f, "", "list"), {}))).map((e) => e.rel)).toHaveLength(6);
    await f.backend.deletePermanent(await resolveRel(f, "d", "delete"), () => {});
    expect(f.exists("d")).toBe(false);
  });

  it("refuses to list a file", async () => {
    const f = await setup();
    f.seed.file("a.txt", "a");
    await expectFm(f.backend.list(await resolveRel(f, "a.txt"), {}), ErrorCode.FM_NOT_A_DIRECTORY);
  });

  it("stats a file, a folder and an inside link", async () => {
    const f = await setup();
    f.seed.file("dir/a.txt", "abc");
    f.seed.link("to-a", "dir/a.txt");
    expect(await f.backend.stat(await resolveRel(f, "dir/a.txt"))).toMatchObject({ name: "a.txt", type: "file", size: 3 });
    expect(await f.backend.stat(await resolveRel(f, "dir", "list"))).toMatchObject({ name: "dir", type: "dir", size: null });
    expect(await f.backend.stat(await resolveRel(f, "to-a", "delete"))).toMatchObject({
      type: "link",
      link: { inside: true, targetType: "file" },
      realRel: "dir/a.txt",
    });
  });
});

// ============================================
// Reading
// ============================================

describe("reading", () => {
  it("reads the head or the tail within maxBytes", async () => {
    const f = await setup();
    f.seed.file("log.txt", "0123456789");
    const r = await resolveRel(f, "log.txt");
    expect(await f.backend.readBytes(r, { maxBytes: 100 })).toEqual({ buffer: Buffer.from("0123456789"), size: 10, truncated: false });
    const head = await f.backend.readBytes(r, { maxBytes: 4 });
    expect(head).toMatchObject({ size: 10, truncated: true });
    expect(head.buffer.toString()).toBe("0123");
    const tail = await f.backend.readBytes(r, { maxBytes: 4, tail: true });
    expect(tail.buffer.toString()).toBe("6789");
    expect(tail.truncated).toBe(true);
    f.seed.file("empty.txt", "");
    expect((await f.backend.readBytes(await resolveRel(f, "empty.txt"), { maxBytes: 10 })).buffer.length).toBe(0);
    await expectFm(f.backend.readBytes(await resolveRel(f, "", "list"), { maxBytes: 10 }), ErrorCode.FM_NOT_A_FILE);
  });

  it("streams a download bounded to the size it reported", async () => {
    const f = await setup();
    const data = crypto.randomBytes(100_000);
    f.seed.file("world.bin", data);
    const { stream, size, close } = await f.backend.openReadStream(await resolveRel(f, "world.bin"));
    expect(size).toBe(100_000);
    expect((await collect(stream)).equals(data)).toBe(true);
    await close();
    const empty = await f.backend.openReadStream(await resolveRel(f, "world.bin"));
    await empty.close();
  });

  it("aborts a download that gets no bytes for the idle limit and drops its connection", async () => {
    const f = await setup({ timeouts: { transferIdleMs: 40 } });
    f.seed.file("world.bin", Buffer.alloc(1024, 7));
    f.server.stallReads = true;
    const pool = getFileManagerSftpPool(f.settings);
    const { stream } = await f.backend.openReadStream(await resolveRel(f, "world.bin"));
    await expectFm(collect(stream), ErrorCode.FM_SFTP_TIMEOUT);
    expect(pool.openClients).toBe(1);
  });
});

// ============================================
// Text save (writeBytesCas)
// ============================================

describe("writeBytesCas", () => {
  const trashMeta = { deletedBy: { userId: "u1", username: "kate" }, reason: "edited" };

  it("creates a new file as 0644 and refuses one that exists", async () => {
    const f = await setup();
    f.seed.dir("Server");
    const r = await resolveRel(f, "Server/new.ini", "create");
    const { entry, previousTrashId } = await f.backend.writeBytesCas(r, Buffer.from("x=1\n"), { expectedHash: null, trashMeta });
    expect(previousTrashId).toBeNull();
    expect(entry).toMatchObject({ name: "new.ini", rel: "Server/new.ini", type: "file", size: 4, mode: 0o644 });
    expect(f.read("Server/new.ini").toString()).toBe("x=1\n");
    await expectFm(f.backend.writeBytesCas(r, Buffer.from("y"), { expectedHash: null, trashMeta }), ErrorCode.FM_EXISTS, {
      name: "new.ini",
    });
    expect(tempNames(f.server, `${ROOT}/Server`)).toEqual([]);
  });

  it("refuses a stale hash with the current etag", async () => {
    const f = await setup();
    f.seed.file("Server/main.ini", "a=1\n");
    const r = await resolveRel(f, "Server/main.ini", "write");
    await expectFm(
      f.backend.writeBytesCas(r, Buffer.from("a=2\n"), { expectedHash: `h:${sha256("old")}`, trashMeta }),
      ErrorCode.FM_CONFLICT,
      { currentEtag: `h:${sha256(Buffer.from("a=1\n"))}` },
    );
    expect(f.read("Server/main.ini").toString()).toBe("a=1\n");
  });

  it("replaces the file atomically, keeps its mode and puts the old version in Trash", async () => {
    const f = await setup();
    f.seed.file("start-server.sh", "#!/bin/sh\necho 1\n", { mode: 0o755 });
    const r = await resolveRel(f, "start-server.sh", "write");
    const { entry, previousTrashId } = await f.backend.writeBytesCas(r, Buffer.from("#!/bin/sh\necho 2\n"), {
      expectedHash: `h:${sha256(Buffer.from("#!/bin/sh\necho 1\n"))}`,
      trashMeta,
    });
    expect(previousTrashId).toMatch(TRASH_ID_RE);
    expect(entry.mode).toBe(0o755);
    expect(f.server.modeOf(`${ROOT}/start-server.sh`)).toBe(0o755);
    expect(f.read("start-server.sh").toString()).toBe("#!/bin/sh\necho 2\n");
    expect(f.server.opCount("posixRename")).toBe(1);
    expect(tempNames(f.server, ROOT)).toEqual([]);

    const items = await f.backend.trashList(f.root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      trashId: previousTrashId,
      originalPath: "start-server.sh",
      type: "file",
      bytes: 17,
      files: 1,
      deletedBy: { username: "kate" },
      reason: "edited",
    });
    expect(f.read(`.zcp-trash/${previousTrashId}/payload/start-server.sh`).toString()).toBe("#!/bin/sh\necho 1\n");
    expect(f.server.modeOf(`${ROOT}/.zcp-trash/${previousTrashId}/payload/start-server.sh`)).toBe(0o755);
    // The bare hash works as well as the "h:" etag.
    await f.backend.writeBytesCas(await resolveRel(f, "start-server.sh", "write"), Buffer.from("3"), {
      expectedHash: sha256(Buffer.from("#!/bin/sh\necho 2\n")),
      trashMeta,
    });
    expect(f.read("start-server.sh").toString()).toBe("3");
  });

  it("falls back to rename-aside when the server lacks posix-rename, and learns it once", async () => {
    const f = await setup({ server: { posixRename: false } });
    f.seed.file("a.ini", "1");
    for (const next of ["2", "3"]) {
      const current = f.read("a.ini");
      await f.backend.writeBytesCas(await resolveRel(f, "a.ini", "write"), Buffer.from(next), {
        expectedHash: sha256(current),
        trashMeta,
      });
      expect(f.read("a.ini").toString()).toBe(next);
    }
    expect(f.server.opCount("posixRename")).toBe(1);
    expect(tempNames(f.server, ROOT)).toEqual([]);
  });

  it("falls back when the server offers posix-rename but refuses it (an older OpenSSH's -P posix-rename)", async () => {
    const f = await setup();
    f.seed.file("a.ini", "1");
    const denied = () => Object.assign(new Error("_posixRename: Permission denied"), { code: 3 });
    f.server.inject("posixRename", { error: denied, times: 99 });
    for (const next of ["2", "3"]) {
      const current = f.read("a.ini");
      await f.backend.writeBytesCas(await resolveRel(f, "a.ini", "write"), Buffer.from(next), {
        expectedHash: sha256(current),
        trashMeta,
      });
      expect(f.read("a.ini").toString()).toBe(next);
    }
    expect(f.server.opCount("posixRename")).toBe(1);
    expect(tempNames(f.server, ROOT)).toEqual([]);
  });

  it("a refused posix-rename over a file the login really can't replace fails, and isn't learned", async () => {
    const f = await setup();
    f.seed.file("a.ini", "1");
    const denied = () => Object.assign(new Error("Permission denied"), { code: 3 });
    f.server.inject("posixRename", { error: denied, times: 99 });
    f.server.inject("rename", { error: denied, path: `${ROOT}/a.ini`, times: 99 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expectFm(
        f.backend.writeBytesCas(await resolveRel(f, "a.ini", "write"), Buffer.from("2"), { expectedHash: sha256(Buffer.from("1")), trashMeta }),
        ErrorCode.FM_OS_PERMISSION_DENIED,
      );
      expect(f.server.opCount("posixRename")).toBe(attempt);
    }
    expect(f.read("a.ini").toString()).toBe("1");
    expect(tempNames(f.server, ROOT)).toEqual([]);
    expect(f.server.childNames(`${ROOT}/.zcp-trash`)).toEqual([]);
  });

  it("rolls back the fallback when the new file can't be renamed into place", async () => {
    const f = await setup({ server: { posixRename: false } });
    f.seed.file("a.ini", "original");
    const r = await resolveRel(f, "a.ini", "write");
    // The first rename moves a.ini aside; the second (new temp file ->
    // a.ini) fails once; the rollback puts a.ini back.
    const originalBefore = f.server.before.bind(f.server);
    let failed = false;
    f.server.before = async (client, op, p) => {
      await originalBefore(client, op, p);
      if (!failed && op === "rename" && p.endsWith(".zcptmp") && !f.exists("a.ini")) {
        failed = true;
        throw Object.assign(new Error(`_rename: Failure ${p}`), { code: 4 });
      }
    };
    await expectFm(
      f.backend.writeBytesCas(r, Buffer.from("changed"), { expectedHash: sha256(Buffer.from("original")), trashMeta }),
      ErrorCode.FM_SFTP_ERROR,
    );
    expect(failed).toBe(true);
    expect(f.read("a.ini").toString()).toBe("original");
    expect(tempNames(f.server, ROOT)).toEqual([]);
  });

  it("keeps at most 20 edited versions of a file", async () => {
    const f = await setup();
    f.seed.file("a.ini", "v0");
    for (let i = 1; i <= FM_LIMITS.TRASH_VERSIONS_PER_FILE + 2; i++) {
      const current = f.read("a.ini");
      await f.backend.writeBytesCas(await resolveRel(f, "a.ini", "write"), Buffer.from(`v${i}`), {
        expectedHash: sha256(current),
        trashMeta,
      });
    }
    const items = (await f.backend.trashList(f.root)).filter((i) => i.originalPath === "a.ini");
    expect(items).toHaveLength(FM_LIMITS.TRASH_VERSIONS_PER_FILE);
  });

  it("takes the config mirror lock and resets its session for writes under the config folder only", async () => {
    const f = await setup({ settings: { panelBridgeSftpConfigPath: `${ROOT}/Server` } });
    f.seed.file("Server/main.ini", "a=1\n");
    f.seed.file("mods/x.lua", "x");
    acquireMirrorLock.mockClear();
    resetRemoteConfigSession.mockClear();

    await f.backend.writeBytesCas(await resolveRel(f, "mods/x.lua", "write"), Buffer.from("y"), {
      expectedHash: sha256(Buffer.from("x")),
      trashMeta,
    });
    expect(acquireMirrorLock).not.toHaveBeenCalled();
    expect(resetRemoteConfigSession).not.toHaveBeenCalled();

    // Hold the mirror lock: the save must wait for it.
    const release = await acquireMirrorLock();
    acquireMirrorLock.mockClear();
    let done = false;
    const saving = f.backend
      .writeBytesCas(await resolveRel(f, "Server/main.ini", "write"), Buffer.from("a=2\n"), {
        expectedHash: sha256(Buffer.from("a=1\n")),
        trashMeta,
      })
      .then(() => {
        done = true;
      });
    await vi.waitFor(() => expect(acquireMirrorLock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(f.read("Server/main.ini").toString()).toBe("a=1\n");
    release();
    await saving;
    expect(f.read("Server/main.ini").toString()).toBe("a=2\n");
    expect(resetRemoteConfigSession).toHaveBeenCalledTimes(1);

    // An upload landing there and a rename out of it count too.
    const upload = Buffer.from("b=1\n");
    await f.backend.receiveUpload(await resolveRel(f, "Server", "list"), "other.ini", Readable.from([upload]), {
      declaredSize: upload.length,
      maxBytes: 1024,
      overwriteEtag: null,
      trashMeta,
    });
    await f.backend.rename(await resolveRel(f, "Server/other.ini", "rename"), "renamed.ini");
    expect(resetRemoteConfigSession).toHaveBeenCalledTimes(3);
  });

  it("recognizes the config folder through its real path", async () => {
    const f = await setup({ settings: { panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server" } });
    f.seed.file("Server/main.ini", "a=1\n");
    f.server.symlink("/home/pz/Zomboid", ROOT);
    resetRemoteConfigSession.mockClear();
    await f.backend.writeBytesCas(await resolveRel(f, "Server/main.ini", "write"), Buffer.from("a=2\n"), {
      expectedHash: sha256(Buffer.from("a=1\n")),
      trashMeta,
    });
    expect(resetRemoteConfigSession).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// Upload
// ============================================

describe("receiveUpload", () => {
  const trashMeta = { deletedBy: { userId: "u1", username: "kate" }, reason: "replaced" };

  function upload(f, dirRel, name, data, opts = {}) {
    return resolveRel(f, dirRel, "list").then((dir) =>
      f.backend.receiveUpload(dir, name, opts.source || Readable.from([data]), {
        declaredSize: opts.declaredSize ?? data.length,
        maxBytes: opts.maxBytes ?? FM_LIMITS.UPLOAD_MAX_BYTES.sftp,
        overwriteEtag: opts.overwriteEtag ?? null,
        trashMeta,
      }),
    );
  }

  it("streams a new file through a temp name and lands it as 0644", async () => {
    const f = await setup();
    f.seed.dir("mods");
    const data = crypto.randomBytes(200_000);
    const out = await upload(f, "mods", "pack.jar", data);
    expect(out.sha256).toBe(sha256(data));
    expect(out.replacedTrashId).toBeNull();
    expect(out.entry).toMatchObject({ name: "pack.jar", rel: "mods/pack.jar", size: 200_000, mode: 0o644 });
    expect(f.read("mods/pack.jar").equals(data)).toBe(true);
    expect(tempNames(f.server, `${ROOT}/mods`)).toEqual([]);
    expect(f.server.log.some((e) => e.op === "createWriteStream" && /\.pack\.jar\.[0-9a-f]{8}\.zcpupload$/.test(e.path))).toBe(true);
  });

  it("refuses an existing name before reading the body", async () => {
    const f = await setup();
    f.seed.file("a.txt", "old");
    const source = new PassThrough();
    await expectFm(upload(f, "", "a.txt", Buffer.from("new"), { source, declaredSize: 3 }), ErrorCode.FM_EXISTS, { name: "a.txt" });
    expect(source.readableFlowing).toBe(null);
    expect(f.read("a.txt").toString()).toBe("old");
  });

  it("overwrites on a matching etag, keeps the mode and trashes the old file", async () => {
    const f = await setup();
    f.seed.file("java/server.jar", "old-jar", { mode: 0o755 });
    const listing = await f.backend.list(await resolveRel(f, "java", "list"), {});
    const etag = listing.entries[0].etag;
    const out = await upload(f, "java", "server.jar", Buffer.from("new-jar!"), { overwriteEtag: etag });
    expect(out.replacedTrashId).toMatch(TRASH_ID_RE);
    expect(f.read("java/server.jar").toString()).toBe("new-jar!");
    expect(f.server.modeOf(`${ROOT}/java/server.jar`)).toBe(0o755);
    const [item] = await f.backend.trashList(f.root);
    expect(item).toMatchObject({ trashId: out.replacedTrashId, originalPath: "java/server.jar", reason: "replaced", bytes: 7 });
  });

  it("refuses a stale overwrite etag and a vanished target", async () => {
    const f = await setup();
    f.seed.file("a.txt", "old");
    await expectFm(upload(f, "", "a.txt", Buffer.from("new"), { overwriteEtag: "s:3-1" }), ErrorCode.FM_CONFLICT);
    await expectFm(upload(f, "", "gone.txt", Buffer.from("new"), { overwriteEtag: "s:3-1" }), ErrorCode.FM_CONFLICT, {
      currentEtag: null,
    });
    expect(f.read("a.txt").toString()).toBe("old");
  });

  it("puts the old file back when the final rename of an overwrite fails", async () => {
    const f = await setup();
    f.seed.file("a.txt", "old");
    const etag = (await f.backend.stat(await resolveRel(f, "a.txt"))).etag;
    const originalBefore = f.server.before.bind(f.server);
    f.server.before = async (client, op, p) => {
      await originalBefore(client, op, p);
      if (op === "rename" && p.endsWith(".zcpupload")) throw Object.assign(new Error(`_rename: Failure ${p}`), { code: 4 });
    };
    await expectFm(upload(f, "", "a.txt", Buffer.from("new"), { overwriteEtag: etag }), ErrorCode.FM_SFTP_ERROR);
    expect(f.read("a.txt").toString()).toBe("old");
    expect(await f.backend.trashList(f.root)).toEqual([]);
    expect(tempNames(f.server, ROOT)).toEqual([]);
  });

  it("rejects bodies shorter or longer than declared and leaves no temp file", async () => {
    const f = await setup();
    await expectFm(upload(f, "", "short.bin", Buffer.from("abc"), { declaredSize: 5 }), ErrorCode.FM_UPLOAD_SIZE_MISMATCH);
    await expectFm(upload(f, "", "long.bin", Buffer.from("abcdef"), { declaredSize: 3 }), ErrorCode.FM_UPLOAD_SIZE_MISMATCH);
    await expectFm(
      upload(f, "", "cap.bin", Buffer.from("abcdef"), { declaredSize: 6, maxBytes: 4 }),
      ErrorCode.FM_UPLOAD_TOO_LARGE,
      { limit: 4 },
    );
    const aborted = new PassThrough();
    const pending = upload(f, "", "aborted.bin", null, { source: aborted, declaredSize: 10 });
    aborted.write("abc");
    setTimeout(() => aborted.destroy(), 10);
    await expectFm(pending, ErrorCode.FM_UPLOAD_SIZE_MISMATCH);

    // Running past the declared size stops the transfer at once, without
    // waiting for the sender to finish or go quiet.
    const flood = new PassThrough();
    const flooding = upload(f, "", "flood.bin", null, { source: flood, declaredSize: 3 });
    flood.write("abcdef");
    const outcome = await Promise.race([
      flooding.then(
        () => "landed",
        (err) => err.code,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still running"), 1000)),
    ]);
    expect(outcome).toBe(ErrorCode.FM_UPLOAD_SIZE_MISMATCH);
    expect(f.server.childNames(ROOT)).toEqual([]);
  });

  it("gives exactly one winner when two uploads race for a name", async () => {
    const f = await setup();
    const results = await Promise.allSettled([
      upload(f, "", "same.txt", Buffer.from("first")),
      upload(f, "", "same.txt", Buffer.from("second")),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe(ErrorCode.FM_EXISTS);
    expect(["first", "second"]).toContain(f.read("same.txt").toString());
    expect(tempNames(f.server, ROOT)).toEqual([]);
  });

  it("aborts a sender that goes quiet, and an SFTP side that stops accepting data", async () => {
    const f = await setup({ timeouts: { transferIdleMs: 40 } });
    const quiet = new PassThrough();
    const pending = upload(f, "", "quiet.bin", null, { source: quiet, declaredSize: 10 });
    quiet.write("abc");
    await expectFm(pending, ErrorCode.FM_UPLOAD_SIZE_MISMATCH);

    f.server.stallWrites = true;
    const big = Buffer.alloc(256 * 1024, 1);
    await expectFm(upload(f, "", "stalled.bin", big), ErrorCode.FM_SFTP_TIMEOUT);
    f.server.stallWrites = false;
  });

  it("refuses unsafe names", async () => {
    const f = await setup();
    await expectFm(upload(f, "", "../x", Buffer.from("x")), ErrorCode.FM_INVALID_NAME, { reason: "slash" });
    await expectFm(upload(f, "", "x.zcpupload", Buffer.from("x")), ErrorCode.FM_INVALID_NAME, { reason: "reservedPanelName" });
    await expectFm(upload(f, "", ".zcp-trash", Buffer.from("x")), ErrorCode.FM_INVALID_NAME, { reason: "reservedPanelName" });
  });

  it("sweeps orphaned temp files older than an hour on the next write into the folder", async () => {
    const f = await setup();
    const hourAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    f.seed.file("mods/.old.jar.0badc0de.zcpupload", "partial", { mtime: hourAgo });
    f.seed.file("mods/.fresh.jar.1badc0de.zcpupload", "in flight");
    await upload(f, "mods", "new.jar", Buffer.from("x"));
    expect(f.exists("mods/.old.jar.0badc0de.zcpupload")).toBe(false);
    expect(f.exists("mods/.fresh.jar.1badc0de.zcpupload")).toBe(true);
  });
});

// ============================================
// mkdir, rename, move, copy
// ============================================

describe("mkdir, rename, move and copyFile", () => {
  it("creates one folder level as 0755 and refuses an existing name", async () => {
    const f = await setup();
    const entry = await f.backend.mkdir(await resolveRel(f, "", "list"), "mods");
    expect(entry).toMatchObject({ name: "mods", rel: "mods", type: "dir" });
    expect(f.server.modeOf(`${ROOT}/mods`)).toBe(0o755);
    await expectFm(f.backend.mkdir(await resolveRel(f, "", "list"), "mods"), ErrorCode.FM_EXISTS, { name: "mods" });
    await expectFm(f.backend.mkdir(await resolveRel(f, "", "list"), "a:b"), ErrorCode.FM_INVALID_NAME, { reason: "colon" });
  });

  it("renames within the folder, refuses a taken name, handles case-only renames and protects the root", async () => {
    const f = await setup();
    f.seed.file("a.txt", "a");
    f.seed.file("b.txt", "b");
    await expectFm(f.backend.rename(await resolveRel(f, "a.txt", "rename"), "b.txt"), ErrorCode.FM_EXISTS, { name: "b.txt" });
    const renamed = await f.backend.rename(await resolveRel(f, "a.txt", "rename"), "c.txt");
    expect(renamed).toMatchObject({ name: "c.txt", rel: "c.txt" });
    const cased = await f.backend.rename(await resolveRel(f, "c.txt", "rename"), "C.txt");
    expect(cased.name).toBe("C.txt");
    expect(f.server.childNames(ROOT)).toEqual(["C.txt", "b.txt"]);
    await expectFm(f.backend.rename(await resolveRel(f, "", "rename"), "x"), ErrorCode.FM_ROOT_IMMUTABLE);
  });

  it("moves within the root, never into itself or onto an existing name", async () => {
    const f = await setup();
    f.seed.file("a/inner/x.txt", "x");
    f.seed.dir("b");
    f.seed.file("b/y.txt", "exists");
    f.seed.file("y.txt", "y");
    await expectFm(
      f.backend.move(await resolveRel(f, "a", "move"), await resolveRel(f, "a/inner", "list")),
      ErrorCode.FM_MOVE_INTO_SELF,
    );
    await expectFm(f.backend.move(await resolveRel(f, "y.txt", "move"), await resolveRel(f, "b", "list")), ErrorCode.FM_EXISTS);
    const moved = await f.backend.move(await resolveRel(f, "a", "move"), await resolveRel(f, "b", "list"));
    expect(moved).toMatchObject({ rel: "b/a", type: "dir" });
    expect(f.read("b/a/inner/x.txt").toString()).toBe("x");
    await expectFm(f.backend.move(await resolveRel(f, "", "move"), await resolveRel(f, "b", "list")), ErrorCode.FM_ROOT_IMMUTABLE);
  });

  it("duplicates a file as a fresh 0644 copy, and replaces only when asked", async () => {
    const f = await setup();
    f.seed.file("start-server.sh", "#!/bin/sh\n", { mode: 0o755 });
    const src = await resolveRel(f, "start-server.sh");
    const root = await resolveRel(f, "", "list");
    const copy = await f.backend.copyFile(src, root, "start-server (copy).sh");
    expect(copy).toMatchObject({ name: "start-server (copy).sh", size: 10, mode: 0o644 });
    expect(f.read("start-server (copy).sh").toString()).toBe("#!/bin/sh\n");
    await expectFm(f.backend.copyFile(src, root, "start-server (copy).sh"), ErrorCode.FM_EXISTS);
    f.seed.file("start-server.sh", "#!/bin/sh\necho v2\n", { mode: 0o755 });
    await expectFm(
      f.backend.copyFile(await resolveRel(f, "start-server.sh"), root, "start-server (copy).sh", { overwriteEtag: "s:1-1" }),
      ErrorCode.FM_CONFLICT,
    );
    const { etag } = await f.backend.stat(await resolveRel(f, "start-server (copy).sh"));
    await f.backend.copyFile(await resolveRel(f, "start-server.sh"), await resolveRel(f, "", "list"), "start-server (copy).sh", {
      overwriteEtag: etag,
      trashMeta: { deletedBy: { userId: "u1", username: "kate" } },
    });
    expect(f.read("start-server (copy).sh").toString()).toBe("#!/bin/sh\necho v2\n");
    expect((await f.backend.trashList(f.root))[0]).toMatchObject({ originalPath: "start-server (copy).sh", reason: "replaced" });
    await expectFm(f.backend.copyFile(root, root, "x"), ErrorCode.FM_NOT_A_FILE);
    expect(tempNames(f.server, ROOT)).toEqual([]);
  });
});

// ============================================
// walk
// ============================================

describe("walk", () => {
  it("yields everything below the item, never following links or entering Trash", async () => {
    const f = await setup();
    f.server.writeFile(`${OUTSIDE}/canary.txt`, CANARY);
    f.seed.file("a/one.txt", "1");
    f.seed.file("a/b/two.txt", "22");
    f.seed.link("a/out", OUTSIDE);
    f.seed.dir(".zcp-trash/20260101T000000Z-abcdef01/payload");
    f.seed.file("a/.x.cafebabe.zcptmp", "tmp");
    const all = await drain(f.backend.walk(await resolveRel(f, "", "list"), {}));
    expect(all.map(({ rel, type, size, depth }) => ({ rel, type, size, depth }))).toEqual([
      { rel: "a", type: "dir", size: 0, depth: 1 },
      { rel: "a/b", type: "dir", size: 0, depth: 2 },
      { rel: "a/one.txt", type: "file", size: 1, depth: 2 },
      { rel: "a/out", type: "link", size: 0, depth: 2 },
      { rel: "a/b/two.txt", type: "file", size: 2, depth: 3 },
    ]);
    expect(all[0]).toMatchObject({ name: "a", realRel: "a", dev: null, ino: null });
    expect(typeof all[0].mtimeMs).toBe("number");
    expect(f.server.log.some((e) => e.op === "list" && e.path.startsWith(OUTSIDE))).toBe(false);
    const single = await drain(f.backend.walk(await resolveRel(f, "a/one.txt"), {}));
    expect(single).toEqual([]);
    const pruned = await drain(f.backend.walk(await resolveRel(f, "", "list"), { prune: (e) => e.rel === "a/b" }));
    expect(pruned.map((e) => e.rel)).not.toContain("a/b/two.txt");
    expect(pruned.map((e) => e.rel)).toContain("a/b");
  });

  it("stops at maxEntries and doesn't enter folders past maxDepth, saying why", async () => {
    const f = await setup();
    f.seed.file("d1/d2/d3/deep.txt", "x");
    f.seed.file("d1/f.txt", "x");
    const byDepth = f.backend.walk(await resolveRel(f, "", "list"), { maxDepth: 2 });
    const shallow = await drain(byDepth);
    expect(shallow.map((e) => e.rel)).toEqual(["d1", "d1/d2", "d1/f.txt"]);
    expect(byDepth.truncated).toBe(true);
    expect(byDepth.truncatedReason).toBe("depth");

    const byCount = f.backend.walk(await resolveRel(f, "", "list"), { maxEntries: 3 });
    expect(await drain(byCount)).toHaveLength(3);
    expect(byCount.truncatedReason).toBe("entries");

    const controller = new AbortController();
    controller.abort();
    const aborted = f.backend.walk(await resolveRel(f, "", "list"), { signal: controller.signal });
    expect(await drain(aborted)).toHaveLength(0);
    expect(aborted.truncatedReason).toBe("aborted");

    const full = f.backend.walk(await resolveRel(f, "", "list"), {});
    await drain(full);
    expect(full.truncated).toBe(false);
  });
});

// ============================================
// Trash and permanent delete
// ============================================

describe("Trash", () => {
  const meta = { deletedBy: { userId: "u1", username: "kate" }, reason: "deleted" };

  it("moves a folder to Trash, lists it and restores it", async () => {
    const f = await setup();
    f.seed.file("mods/pack/a.lua", "aa");
    f.seed.file("mods/pack/b.lua", "bbb");
    const { trashId } = await f.backend.trashMove(await resolveRel(f, "mods/pack", "delete"), meta);
    expect(trashId).toMatch(TRASH_ID_RE);
    expect(f.exists("mods/pack")).toBe(false);
    expect(f.read(`.zcp-trash/${trashId}/payload/pack/a.lua`).toString()).toBe("aa");

    const items = await f.backend.trashList(f.root);
    expect(items).toEqual([
      expect.objectContaining({ trashId, originalPath: "mods/pack", type: "dir", bytes: 5, files: 2, reason: "deleted" }),
    ]);
    const expires = Date.parse(items[0].expiresAt) - Date.parse(items[0].deletedAt);
    expect(Math.abs(expires - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(2000);
    expect(items[0].deletedBy).toEqual({ username: "kate" });
    expect((await f.backend.describeRoot(f.spec)).trashItemCount).toBe(1);

    // The Trash never shows up in the folder it belongs to.
    const listing = await f.backend.list(await resolveRel(f, "", "list"), {});
    expect(listing.entries.map((e) => e.name)).toEqual(["mods"]);

    const restored = await f.backend.trashRestore(f.root, trashId);
    expect(restored).toMatchObject({ rel: "mods/pack", type: "dir" });
    expect(f.read("mods/pack/b.lua").toString()).toBe("bbb");
    expect(await f.backend.trashList(f.root)).toEqual([]);
    expect(f.exists(`.zcp-trash/${trashId}`)).toBe(false);
  });

  it("refuses to restore over an existing name, and restores under another one", async () => {
    const f = await setup();
    f.seed.file("a.txt", "one");
    const { trashId } = await f.backend.trashMove(await resolveRel(f, "a.txt", "delete"), meta);
    f.seed.file("a.txt", "two");
    await expectFm(f.backend.trashRestore(f.root, trashId), ErrorCode.FM_EXISTS, { name: "a.txt" });
    await expectFm(f.backend.trashRestore(f.root, trashId, "a/b"), ErrorCode.FM_INVALID_NAME);
    const restored = await f.backend.trashRestore(f.root, trashId, "a (restored).txt");
    expect(restored.rel).toBe("a (restored).txt");
    expect(f.read("a (restored).txt").toString()).toBe("one");
    expect(f.read("a.txt").toString()).toBe("two");
  });

  it("treats meta.json as untrusted", async () => {
    const f = await setup();
    f.server.mkdirp(OUTSIDE);
    f.seed.file("a.txt", "one");
    const { trashId } = await f.backend.trashMove(await resolveRel(f, "a.txt", "delete"), meta);
    // Tamper: point the item somewhere it must never land.
    await closeFileManagerSftpPool();
    const tampered = { v: 1, originalPath: "../../secret/a.txt", type: "file", bytes: 3, files: 1, deletedAt: new Date().toISOString(), deletedBy: {}, reason: "deleted" };
    f.server.writeFile(`${ROOT}/.zcp-trash/${trashId}/meta.json`, JSON.stringify(tampered));
    const backend = createSftpBackend({ settings: f.settings });
    expect(await backend.trashList(f.root)).toEqual([]);
    await expectFm(backend.trashRestore(f.root, trashId), ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    await expectFm(backend.trashRestore(f.root, "../../etc"), ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    expect(f.server.exists(`${OUTSIDE}/a.txt`)).toBe(false);

    // A restore whose parent is now a link out of the root is refused too.
    const good = { ...tampered, originalPath: "sub/a.txt" };
    f.server.writeFile(`${ROOT}/.zcp-trash/${trashId}/meta.json`, JSON.stringify(good));
    f.seed.link("sub", OUTSIDE);
    await closeFileManagerSftpPool();
    const again = createSftpBackend({ settings: f.settings });
    await expectFm(again.trashRestore(f.root, trashId), ErrorCode.FM_LINK_ESCAPES_ROOT);
    expect(f.server.exists(`${OUTSIDE}/a.txt`)).toBe(false);
  });

  it("won't follow a planted .zcp-trash link", async () => {
    const f = await setup();
    f.server.mkdirp(OUTSIDE);
    f.seed.link(".zcp-trash", OUTSIDE);
    f.seed.file("a.txt", "one");
    await expectFm(f.backend.trashMove(await resolveRel(f, "a.txt", "delete"), meta), ErrorCode.FM_TRASH_UNAVAILABLE, {
      reason: "notWritable",
    });
    expect(f.read("a.txt").toString()).toBe("one");
    expect(f.server.childNames(OUTSIDE)).toEqual([]);
    expect(await f.backend.trashList(f.root)).toEqual([]);
  });

  it("reports a cross-device Trash and cleans up the empty item", async () => {
    const f = await setup();
    f.seed.file("mnt/a.bin", "x");
    const originalBefore = f.server.before.bind(f.server);
    f.server.before = async (client, op, p) => {
      await originalBefore(client, op, p);
      if (op === "rename" && p === `${ROOT}/mnt/a.bin`) throw Object.assign(new Error(`_rename: Failure ${p}`), { code: 4 });
    };
    await expectFm(f.backend.trashMove(await resolveRel(f, "mnt/a.bin", "delete"), meta), ErrorCode.FM_TRASH_UNAVAILABLE, {
      reason: "crossDevice",
    });
    expect(f.server.childNames(`${ROOT}/.zcp-trash`)).toEqual([]);
    expect(f.read("mnt/a.bin").toString()).toBe("x");
  });

  it("expires items older than 7 days when Trash is listed or written", async () => {
    const f = await setup();
    const old = "20200101T000000Z-0123abcd";
    f.seed.file(`.zcp-trash/${old}/payload/old.txt`, "old");
    f.seed.file(
      `.zcp-trash/${old}/meta.json`,
      JSON.stringify({ v: 1, originalPath: "old.txt", type: "file", bytes: 3, files: 1, deletedAt: "2020-01-01T00:00:00.000Z", deletedBy: {}, reason: "deleted" }),
    );
    expect(await f.backend.trashList(f.root)).toEqual([]);
    expect(f.exists(`.zcp-trash/${old}`)).toBe(false);

    f.seed.file(`.zcp-trash/${old}/payload/old.txt`, "old");
    f.seed.file("a.txt", "a");
    await f.backend.trashMove(await resolveRel(f, "a.txt", "delete"), meta);
    expect(f.exists(`.zcp-trash/${old}`)).toBe(false);
  });

  it("permanently deletes a Trash item and a tree without following links or using recursive rmdir", async () => {
    const f = await setup();
    f.server.writeFile(`${OUTSIDE}/canary.txt`, CANARY);
    f.seed.file("world/map/a.bin", "a");
    f.seed.file("world/map/b.bin", "b");
    f.seed.link("world/escape", OUTSIDE);
    f.seed.link("world/inside", "map");
    const progress = [];
    await f.backend.deletePermanent(await resolveRel(f, "world", "delete"), (done, total) => progress.push([done, total]));
    expect(f.exists("world")).toBe(false);
    expect(f.server.readFile(`${OUTSIDE}/canary.txt`).toString()).toBe(CANARY);
    expect(progress.at(-1)).toEqual([6, null]);
    expect(f.server.recursiveRmdirCalls).toBe(0);
    expect(f.server.opCount("rmdirLibrary")).toBe(0);

    f.seed.file("a.txt", "a");
    const { trashId } = await f.backend.trashMove(await resolveRel(f, "a.txt", "delete"), meta);
    await f.backend.deletePermanent({ root: f.root, trashId }, () => {});
    expect(f.exists(`.zcp-trash/${trashId}`)).toBe(false);
    await expectFm(f.backend.deletePermanent({ root: f.root, trashId }, () => {}), ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    await expectFm(f.backend.deletePermanent({ root: f.root, trashId: "../x" }, () => {}), ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    await expectFm(f.backend.deletePermanent(await resolveRel(f, "", "delete"), () => {}), ErrorCode.FM_ROOT_IMMUTABLE);
    await expectFm(f.backend.trashMove(await resolveRel(f, "", "delete"), meta), ErrorCode.FM_ROOT_IMMUTABLE);
  });
});

// ============================================
// Optional live check against a real SFTP server (skipped in CI)
// ============================================

describe.skipIf(!process.env.FM_SFTP_LIVE)("live SFTP (FM_SFTP_LIVE=1)", () => {
  it("lists, writes, trashes and purges in a scratch folder", async () => {
    // FM_SFTP_HOST/PORT/USER/PASSWORD name the login; FM_SFTP_ROOT an
    // absolute folder this test may create a scratch subfolder in.
    const settings = {
      panelBridgeSftpHost: process.env.FM_SFTP_HOST,
      panelBridgeSftpPort: Number(process.env.FM_SFTP_PORT || 22),
      panelBridgeSftpUsername: process.env.FM_SFTP_USER,
      panelBridgeSftpPassword: process.env.FM_SFTP_PASSWORD,
    };
    const backend = createSftpBackend({ settings });
    const root = await backend.describeRoot({ id: "data", path: process.env.FM_SFTP_ROOT, warnings: [] });
    expect(root.available).toBe(true);
    const scratchName = `zcp-live-${crypto.randomBytes(4).toString("hex")}`;
    const scratch = await backend.mkdir(await backend.resolve(root, [], "list"), scratchName);
    const dir = await backend.resolve(root, [scratch.rel], "list");
    const target = await backend.resolve(root, [scratch.rel, "a.txt"], "create");
    await backend.writeBytesCas(target, Buffer.from("one\n"), { expectedHash: null, trashMeta: { deletedBy: {} } });
    const read = await backend.readBytes(await backend.resolve(root, [scratch.rel, "a.txt"], "read"), { maxBytes: 100 });
    expect(read.buffer.toString()).toBe("one\n");
    expect((await backend.list(dir, {})).entries.map((e) => e.name)).toEqual(["a.txt"]);
    const { trashId } = await backend.trashMove(await backend.resolve(root, [scratch.rel], "delete"), { deletedBy: {} });
    await backend.deletePermanent({ root, trashId }, () => {});
  });
});
