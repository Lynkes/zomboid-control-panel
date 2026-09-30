import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { PassThrough } from "stream";
import unzipper from "unzipper";
import { fakeApp, makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// Selections that hold a folder and something inside it (search results
// make them), restores whose folder is gone, the one-request restore that
// Undo uses, and a search stopped by the depth limit.

const dbState = vi.hoisted(() => ({ servers: [], settings: {}, audit: [] }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
    appendFileAudit: async (row) => {
      dbState.audit.unshift(row);
      return row;
    },
  };
});

const service = await import("../services/fileManagerService.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests, _setRunStateDepsForTests } = await import("../services/fileManagerRunState.js");
const { _resetJobsForTests, _waitForJobForTests } = await import("../services/fileManagerJobs.js");
const { _resetZipSlotsForTests } = await import("../services/fileManagerZip.js");
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

const ctx = () => service.loadProfileContext(tree.profile.id, fakeApp());
const at = (...parts) => path.join(tree.data, ...parts);

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FmError) return err;
    throw err;
  }
  throw new Error("expected an FmError");
}

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  dbState.audit = [];
  invalidateRootCache();
  _setRunStateDepsForTests({});
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  _resetZipSlotsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(() => {
  removeDir(base);
});

describe("a folder selected together with something inside it", () => {
  beforeEach(() => {
    write(at("mods", "A", "a.lua"), "a");
    write(at("mods", "A", "b.lua"), "bb");
    write(at("dest", ".keep"), "");
  });

  it("delete preview counts each file once, and the permanent delete finishes 'done'", async () => {
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: ["mods/A", "mods/A/a.lua"] }, user);
    expect(preview.items.map((item) => item.path)).toEqual(["mods/A"]);
    expect(preview.totals).toMatchObject({ files: 2, bytes: 3 });
    const started = await service.deleteItems(
      c,
      { root: "data", previewId: preview.previewId, mode: "permanent", confirm: ["permanent"], typedConfirmation: "A" },
      user,
      audit(),
    );
    const job = await _waitForJobForTests(started.body.jobId);
    expect(job.state).toBe("done");
    expect(fs.existsSync(at("mods", "A"))).toBe(false);
  });

  it("delete to Trash reports nothing failed", async () => {
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: ["mods/A/a.lua", "mods/A"] }, user);
    const result = await service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "trash", confirm: preview.required }, user, audit());
    expect(result.body.failed).toEqual([]);
    expect(result.body.trashed.map((t) => t.path)).toEqual(["mods/A"]);
  });

  it("move reports the folder moved and nothing failed", async () => {
    const scope = audit();
    const result = await service.moveEntries(await ctx(), { root: "data", paths: ["mods/A", "mods/A/a.lua"], destDir: "dest", confirm: [] }, user, scope);
    expect(result).toEqual({ moved: [{ from: "mods/A", to: "dest/A" }], failed: [] });
    expect(scope.result).toBe("ok");
    expect(fs.readFileSync(at("dest", "A", "a.lua"), "utf8")).toBe("a");
  });

  it("move still moves the file when its folder can't go", async () => {
    // The folder refuses (it would move into itself); the file inside it
    // is its own selection then.
    const result = await service.moveEntries(
      await ctx(),
      { root: "data", paths: ["mods/A", "mods/A/a.lua"], destDir: "mods/A/sub", confirm: [] },
      user,
      audit(),
    ).catch((err) => err);
    // mods/A/sub doesn't exist: the whole request is refused, nothing moved.
    expect(result).toBeInstanceOf(FmError);
    fs.mkdirSync(at("mods", "A", "sub"));
    const moved = await service.moveEntries(await ctx(), { root: "data", paths: ["mods/A", "mods/A/a.lua"], destDir: "mods/A/sub", confirm: [] }, user, audit());
    expect(moved.moved).toEqual([{ from: "mods/A/a.lua", to: "mods/A/sub/a.lua" }]);
    expect(moved.failed.map((f) => [f.path, f.code])).toEqual([["mods/A", "FM_MOVE_INTO_SELF"]]);
  });

  it("zip holds the file once", async () => {
    const zip = await service.prepareZip(await ctx(), { root: "data", paths: ["mods/A", "mods/A/a.lua"] }, user, audit());
    const res = new PassThrough();
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    try {
      await zip.stream(res);
    } finally {
      zip.release();
    }
    const dir = await unzipper.Open.buffer(Buffer.concat(chunks));
    expect(dir.files.filter((f) => f.path.endsWith("a.lua")).map((f) => f.path)).toEqual(["A/a.lua"]);
  });
});

describe("a selection over the per-request limit", () => {
  it("is refused with the limit, so the client can split it", async () => {
    const paths = Array.from({ length: 201 }, (_, i) => `Logs/logs_${i}`);
    for (const call of [
      (c) => service.deletePreview(c, { root: "data", paths }, user),
      (c) => service.prepareZip(c, { root: "data", paths }, user, audit()),
      (c) => service.moveEntries(c, { root: "data", paths, destDir: "", confirm: [] }, user, audit()),
    ]) {
      const err = await failure(call(await ctx()));
      expect(err).toMatchObject({ code: "FM_INVALID_REQUEST", params: { field: "paths", limit: 200 } });
    }
  });
});

describe("restoring from Trash", () => {
  async function trashOne(rel) {
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: [rel] }, user);
    const result = await service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "trash", confirm: preview.required }, user, audit());
    return result.body.trashed[0].trashId;
  }

  it("recreates the folders a restore needs when its original folder is gone", async () => {
    write(at("mods", "B", "keep.lua"), "keep me");
    const trashId = await trashOne("mods/B/keep.lua");
    fs.renameSync(at("mods", "B"), at("mods", "B-old"));
    const restored = await service.restoreTrashItem(await ctx(), { root: "data", trashId, confirm: [] }, user, audit());
    expect(restored.entry.path).toBe("mods/B/keep.lua");
    expect(fs.readFileSync(at("mods", "B", "keep.lua"), "utf8")).toBe("keep me");
    // restoreAs works there too.
    const again = await trashOne("mods/B/keep.lua");
    fs.rmSync(at("mods", "B"), { recursive: true });
    await service.restoreTrashItem(await ctx(), { root: "data", trashId: again, restoreAs: "keep2.lua", confirm: [] }, user, audit());
    expect(fs.existsSync(at("mods", "B", "keep2.lua"))).toBe(true);
  });

  it("a recreated folder is checked like any new one", async () => {
    write(at("backups-old", "x.txt"), "x");
    const trashId = await trashOne("backups-old/x.txt");
    // Trash says the file came from inside World Backups, which is protected.
    const itemDir = path.join(trash.trashDirOf(tree.data), trashId);
    const meta = JSON.parse(fs.readFileSync(path.join(itemDir, "meta.json"), "utf8"));
    fs.rmSync(path.join(itemDir, "meta.json"));
    fs.writeFileSync(path.join(itemDir, "meta.json"), JSON.stringify({ ...meta, originalPath: "backups/new/x.txt" }));
    const err = await failure(service.restoreTrashItem(await ctx(), { root: "data", trashId, confirm: [] }, user, audit()));
    expect(err.code).toBe("FM_PATH_PROTECTED");
    expect(fs.existsSync(at("backups", "new"))).toBe(false);
  });

  it("restores many items in one request, with one confirmation and per-item results (Undo of a bulk delete)", async () => {
    const paths = [];
    for (let i = 0; i < 100; i++) {
      write(at("Logs", "bulk", `f${i}.txt`), `${i}`);
      paths.push(`Logs/bulk/f${i}.txt`);
    }
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths }, user);
    const deleted = await service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "trash", confirm: [] }, user, audit());
    expect(deleted.body.trashed).toHaveLength(100);
    // One of them can't come back: its name was taken meanwhile.
    write(at("Logs", "bulk", "f7.txt"), "newer");
    const scope = audit();
    const result = await service.restoreTrashItem(
      await ctx(),
      { root: "data", trashIds: deleted.body.trashed.map((t) => t.trashId), confirm: [] },
      user,
      scope,
    );
    expect(result.restored).toHaveLength(99);
    expect(result.failed).toEqual([{ trashId: deleted.body.trashed[7].trashId, code: "FM_EXISTS", params: { name: "f7.txt" } }]);
    expect(scope.result).toBe("partial");
    expect(fs.readdirSync(at("Logs", "bulk"))).toHaveLength(100);
    expect(fs.readFileSync(at("Logs", "bulk", "f7.txt"), "utf8")).toBe("newer");
  });

  it("a batch restore needs the same confirmations as one at a time, asked once", async () => {
    write(at("scripts", "a.sh"), "#!/bin/sh\n");
    write(at("scripts", "b.sh"), "#!/bin/sh\n");
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: ["scripts/a.sh", "scripts/b.sh"] }, user);
    const deleted = await service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "trash", confirm: [] }, user, audit());
    const trashIds = deleted.body.trashed.map((t) => t.trashId);
    const err = await failure(service.restoreTrashItem(await ctx(), { root: "data", trashIds, confirm: [] }, user, audit()));
    expect(err.code).toBe("FM_CONFIRMATION_REQUIRED");
    expect(fs.existsSync(at("scripts", "a.sh"))).toBe(false);
    const ok = await service.restoreTrashItem(await ctx(), { root: "data", trashIds, confirm: ["executable"] }, user, audit());
    expect(ok.restored).toHaveLength(2);
  });
});

describe("search", () => {
  it("says it stopped early when folders were left unopened at the depth limit", async () => {
    write(
      path.join(tree.install, "steamapps", "workshop", "content", "108600", "2392709985", "mods", "Hydrocraft", "42", "media", "lua", "client", "HCUI", "HCCraftingWindow.lua"),
      "--",
    );
    const deep = await service.search(await ctx(), { root: "install", path: "", q: "HCCrafting" });
    expect(deep.results).toEqual([]);
    expect(deep.truncated).toBe(true);
    const nearer = await service.search(await ctx(), { root: "install", path: "steamapps", q: "HCCrafting" });
    expect(nearer.results.map((r) => r.name)).toEqual(["HCCraftingWindow.lua"]);
    expect(nearer.truncated).toBe(false);
    // An empty folder at the limit cut nothing short.
    fs.mkdirSync(path.join(tree.install, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"), { recursive: true });
    const shallow = await service.search(await ctx(), { root: "install", path: "a", q: "zzz" });
    expect(shallow.truncated).toBe(false);
  });
});
