// The Server Files backend contract (spec §A13), as tests every backend must
// pass: the local backend runs it in fileManagerLocalConformance.test.js,
// the SFTP backend against its in-memory fake. Only the FileBackend
// interface is used, never the backend's internals.
//
//   runBackendConformance("local", async () => ({
//     backend,                  // the FileBackend under test
//     root: { id: "data", path: "/abs/root" },   // a RootSpec, empty folder
//     seed: {                   // how the test reaches the storage directly
//       mkdir(rel), writeFile(rel, content), readFile(rel) -> string|null, exists(rel) -> boolean,
//     },
//     cleanup(),                // optional
//   }));
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmError } from "../../services/fileManagerContract.js";
import { hashEtag } from "../../services/fileManagerTextCodec.js";

const segs = (rel) => (rel ? rel.split("/") : []);
const meta = { deletedBy: { userId: "u1", username: "kate" }, reason: "deleted" };

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    if (!(err instanceof FmError)) throw new Error(`expected an FmError, got ${err?.name}: ${err?.message}`);
    return err.code;
  }
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/**
 * @param {string} name
 * @param {() => Promise<{ backend: object, root: object, seed: object, cleanup?: () => unknown }>} makeBackend
 */
export function runBackendConformance(name, makeBackend) {
  describe(`FileBackend conformance: ${name}`, () => {
    let env;
    let backend;
    let root;
    let seed;

    const resolve = (rel, intent = "read") => backend.resolve(root, segs(rel), intent);

    beforeEach(async () => {
      env = await makeBackend();
      ({ backend, seed } = env);
      root = await backend.describeRoot(env.root);
      await seed.mkdir("dir");
      await seed.mkdir("dir/sub");
      await seed.writeFile("a.txt", "alpha");
      await seed.writeFile("B.txt", "bravo-bravo");
      await seed.writeFile("dir/c.txt", "charlie");
      await seed.writeFile("dir/sub/d.txt", "delta");
    });

    afterEach(async () => {
      await env?.cleanup?.();
    });

    it("describes an available root", () => {
      expect(root.available).toBe(true);
      expect(root.id).toBe(env.root.id);
      expect(typeof root.real).toBe("string");
      expect(["local", "docker", "sftp"]).toContain(root.backend);
      expect(Array.isArray(root.warnings)).toBe(true);
      expect(backend.kind).toMatch(/^(local|sftp)$/);
    });

    it("resolves files, folders, the root and new names", async () => {
      const file = await resolve("dir/c.txt");
      expect(file.stat.type).toBe("file");
      expect(file).toMatchObject({ name: "c.txt", rel: "dir/c.txt", realRel: "dir/c.txt", isNew: false });
      expect(file.linkSelf).toBeFalsy();
      expect((await resolve("a.txt")).stat.type).toBe("file");
      expect((await resolve("dir", "list")).stat.type).toBe("dir");
      const top = await resolve("", "list");
      expect(top.rel).toBe("");
      expect(top.realRel).toBe("");
      expect(top.name).toBe("");
      const fresh = await resolve("dir/new.txt", "create");
      expect(fresh.isNew).toBe(true);
      expect(fresh.rel).toBe("dir/new.txt");
      expect(fresh.name).toBe("new.txt");
      expect(await codeOf(resolve("missing.txt"))).toBe("FM_NOT_FOUND");
      expect(await codeOf(resolve("missing/new.txt", "create"))).toBe("FM_NOT_FOUND");
    });

    it("lists with sorting, folders first, and paging; hides panel names", async () => {
      await seed.mkdir(".zcp-trash");
      await seed.writeFile(".x.txt.1.abcdef12.zcpupload", "temp");
      const r = await resolve("", "list");
      const all = await backend.list(r, { offset: 0, limit: 100, sort: "name", order: "asc" });
      expect(all.entries.map((e) => e.name)).toEqual(["dir", "a.txt", "B.txt"]);
      expect(all.total).toBe(3);
      expect(typeof all.dirEtag).toBe("string");
      const desc = await backend.list(r, { offset: 0, limit: 100, sort: "size", order: "desc" });
      expect(desc.entries.map((e) => e.name)).toEqual(["dir", "B.txt", "a.txt"]);
      const page = await backend.list(r, { offset: 1, limit: 1, sort: "name", order: "asc" });
      expect(page.entries.map((e) => e.name)).toEqual(["a.txt"]);
      expect(page.total).toBe(3);
      const file = all.entries.find((e) => e.name === "a.txt");
      expect(file).toMatchObject({ rel: "a.txt", type: "file", size: 5 });
      expect(typeof file.etag).toBe("string");
    });

    it("stats an entry", async () => {
      const entry = await backend.stat(await resolve("dir/c.txt"));
      expect(entry).toMatchObject({ name: "c.txt", rel: "dir/c.txt", type: "file", size: 7 });
    });

    it("reads bytes, whole or the tail", async () => {
      const r = await resolve("B.txt");
      const whole = await backend.readBytes(r, { maxBytes: 1024 });
      expect(whole.buffer.toString()).toBe("bravo-bravo");
      expect(whole.truncated).toBe(false);
      const tail = await backend.readBytes(r, { maxBytes: 5, tail: true });
      expect(tail.buffer.toString()).toBe("bravo");
      expect(tail.truncated).toBe(true);
      expect(tail.size).toBe(11);
      const head = await backend.readBytes(r, { maxBytes: 5 });
      expect(head.buffer.toString()).toBe("bravo");
    });

    it("streams a file", async () => {
      const handle = await backend.openReadStream(await resolve("dir/c.txt"));
      expect(handle.size).toBe(7);
      expect(await readAll(handle.stream)).toBe("charlie");
      await handle.close();
    });

    it("writes with compare-and-swap", async () => {
      const created = await backend.writeBytesCas(await resolve("new.txt", "create"), Buffer.from("one"), { expectedHash: null, trashMeta: meta });
      expect(created.entry).toMatchObject({ name: "new.txt", type: "file" });
      expect(created.previousTrashId).toBeNull();
      expect(await seed.readFile("new.txt")).toBe("one");
      expect(await codeOf(backend.writeBytesCas(await resolve("new.txt", "create"), Buffer.from("x"), { expectedHash: null, trashMeta: meta }))).toBe(
        "FM_EXISTS",
      );
      const current = await resolve("new.txt", "write");
      expect(await codeOf(backend.writeBytesCas(current, Buffer.from("x"), { expectedHash: hashEtag(Buffer.from("stale")), trashMeta: meta }))).toBe(
        "FM_CONFLICT",
      );
      const updated = await backend.writeBytesCas(await resolve("new.txt", "write"), Buffer.from("two"), {
        expectedHash: hashEtag(Buffer.from("one")),
        trashMeta: meta,
      });
      expect(await seed.readFile("new.txt")).toBe("two");
      expect(typeof updated.previousTrashId).toBe("string");
    });

    it("receives uploads: new, taken, overwrite with etag, short body", async () => {
      const dir = await resolve("dir", "list");
      const first = await backend.receiveUpload(dir, "up.txt", Readable.from([Buffer.from("upload")]), {
        declaredSize: 6,
        maxBytes: 1024,
        overwriteEtag: null,
        trashMeta: meta,
      });
      expect(first.entry).toMatchObject({ name: "up.txt", type: "file", size: 6 });
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.replacedTrashId).toBeNull();
      expect(
        await codeOf(
          backend.receiveUpload(await resolve("dir", "list"), "up.txt", Readable.from([Buffer.from("again!")]), {
            declaredSize: 6,
            maxBytes: 1024,
            overwriteEtag: null,
            trashMeta: meta,
          }),
        ),
      ).toBe("FM_EXISTS");
      const replaced = await backend.receiveUpload(await resolve("dir", "list"), "up.txt", Readable.from([Buffer.from("newer!")]), {
        declaredSize: 6,
        maxBytes: 1024,
        overwriteEtag: first.entry.etag,
        trashMeta: meta,
      });
      expect(typeof replaced.replacedTrashId).toBe("string");
      expect(await seed.readFile("dir/up.txt")).toBe("newer!");
      expect(
        await codeOf(
          backend.receiveUpload(await resolve("dir", "list"), "short.txt", Readable.from([Buffer.from("abc")]), {
            declaredSize: 10,
            maxBytes: 1024,
            overwriteEtag: null,
            trashMeta: meta,
          }),
        ),
      ).toBe("FM_UPLOAD_SIZE_MISMATCH");
      expect(await seed.exists("dir/short.txt")).toBe(false);
    });

    it("makes folders, renames, moves and copies", async () => {
      const made = await backend.mkdir(await resolve("", "list"), "made");
      expect(made).toMatchObject({ name: "made", type: "dir" });
      expect(await codeOf(backend.mkdir(await resolve("", "list"), "made"))).toBe("FM_EXISTS");

      const renamed = await backend.rename(await resolve("a.txt", "rename"), "renamed.txt");
      expect(renamed.name).toBe("renamed.txt");
      expect(await seed.exists("a.txt")).toBe(false);
      expect(await codeOf(backend.rename(await resolve("renamed.txt", "rename"), "B.txt"))).toBe("FM_EXISTS");

      const moved = await backend.move(await resolve("renamed.txt", "move"), await resolve("made", "list"));
      expect(moved.rel).toBe("made/renamed.txt");
      expect(await seed.readFile("made/renamed.txt")).toBe("alpha");
      await seed.writeFile("B-dup.txt", "x");
      expect(await codeOf(backend.move(await resolve("B-dup.txt", "move"), await resolve("", "list")))).toBe("FM_EXISTS");

      const copy = await backend.copyFile(await resolve("B.txt"), await resolve("dir", "list"), "B (copy).txt");
      expect(copy.name).toBe("B (copy).txt");
      expect(await seed.readFile("dir/B (copy).txt")).toBe("bravo-bravo");
      expect(await seed.readFile("B.txt")).toBe("bravo-bravo");
    });

    it("walks without following anything and reports depth", async () => {
      const entries = await collect(backend.walk(await resolve("dir", "list"), { maxEntries: 100, maxDepth: 10, maxMs: 5000 }));
      const rels = entries.map((e) => e.rel).sort();
      expect(rels).toEqual(["dir/c.txt", "dir/sub", "dir/sub/d.txt"]);
      expect(entries.find((e) => e.rel === "dir/sub/d.txt")).toMatchObject({ type: "file", size: 5 });
      const shallow = await collect(backend.walk(await resolve("dir", "list"), { maxEntries: 100, maxDepth: 1, maxMs: 5000 }));
      expect(shallow.map((e) => e.rel).sort()).toEqual(["dir/c.txt", "dir/sub"]);
    });

    it("moves to Trash, lists, restores (and restores under another name)", async () => {
      const { trashId } = await backend.trashMove(await resolve("dir/c.txt", "delete"), meta);
      expect(trashId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
      expect(await seed.exists("dir/c.txt")).toBe(false);
      const items = await backend.trashList(root);
      expect(items.find((i) => i.trashId === trashId)).toMatchObject({ originalPath: "dir/c.txt", type: "file", reason: "deleted" });
      const text = await backend.trashReadBytes(root, trashId, { maxBytes: 1024 });
      expect(text).toMatchObject({ size: 7, truncated: false });
      expect(text.buffer.toString()).toBe("charlie");
      expect((await backend.trashReadBytes(root, trashId, { maxBytes: 3 })).truncated).toBe(true);
      expect(await codeOf(backend.trashReadBytes(root, "20200101T000000Z-abcdef01", { maxBytes: 10 }))).toBe("FM_TRASH_ITEM_NOT_FOUND");
      await seed.writeFile("dir/c.txt", "taken");
      expect(await codeOf(backend.trashRestore(root, trashId))).toBe("FM_EXISTS");
      const restored = await backend.trashRestore(root, trashId, "c (restored).txt");
      expect(restored.name).toBe("c (restored).txt");
      expect(await seed.readFile("dir/c (restored).txt")).toBe("charlie");
      expect((await backend.trashList(root)).some((i) => i.trashId === trashId)).toBe(false);
      expect(await codeOf(backend.trashRestore(root, trashId))).toBe("FM_TRASH_ITEM_NOT_FOUND");
    });

    it("deletes for good: a folder tree, and a Trash item", async () => {
      await backend.deletePermanent(await resolve("dir", "delete"), () => {});
      expect(await seed.exists("dir")).toBe(false);
      const { trashId } = await backend.trashMove(await resolve("B.txt", "delete"), meta);
      await backend.deletePermanent({ root, trashId }, () => {});
      expect((await backend.trashList(root)).some((i) => i.trashId === trashId)).toBe(false);
    });

    it("reports free space as numbers or nulls", async () => {
      const space = await backend.freeSpace(root);
      expect(space.free === null || typeof space.free === "number").toBe(true);
      expect(space.total === null || typeof space.total === "number").toBe(true);
    });
  });
}
