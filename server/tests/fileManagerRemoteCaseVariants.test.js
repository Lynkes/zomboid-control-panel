import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "stream";
import unzipper from "unzipper";

// A panel on Windows or macOS (whose own paths fold case) managing a Linux
// host over SFTP, where Readme.txt and README.txt are two different files.
// Selections are de-duplicated (a folder and something inside it, the same
// path twice); for a remote root that must follow the host, not the panel,
// or one of two selected files is silently left out of a delete, move or
// zip that then reports success. foldRel is made to fold here so the test
// means the same on a Linux CI runner as on a Windows panel.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
    getSetting: async (key) => dbState.settings[key],
    getActiveServer: async () => dbState.servers.find((s) => s.isActive) || null,
    appendFileAudit: async (row) => row,
  };
});

vi.mock("../services/fileManagerProtectedAreas.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, CASE_FOLD: true, foldRel: (rel) => String(rel).toLowerCase() };
});

const service = await import("../services/fileManagerService.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const { _resetJobsForTests } = await import("../services/fileManagerJobs.js");
const { _resetZipSlotsForTests } = await import("../services/fileManagerZip.js");
const { closeFileManagerSftpPool } = await import("../services/fileManagerSftpBackend.js");
const { _setFileManagerSftpTestHooks } = await import("../services/fileManagerSftpPool.js");
const { FakeSftpServer } = await import("./helpers/fakeSftp.js");

const DATA = "/srv/pz/Zomboid";
const user = { userId: "u1", username: "kate", role: "admin" };
const app = { get: (k) => (k === "serverManager" ? { getServerProcessDetails: async () => ({ running: false, matched: [], owned: [] }) } : null) };
const audit = () => {
  const scope = {};
  scope.defer = () => ({ finish: async () => {} });
  return scope;
};
const ctx = () => service.loadProfileContext("r1", app);
let sftp;

beforeEach(() => {
  sftp = new FakeSftpServer();
  sftp.writeFile(`${DATA}/Logs/Readme.txt`, "one\n");
  sftp.writeFile(`${DATA}/Logs/README.txt`, "two, a different file\n");
  sftp.writeFile(`${DATA}/dest/.keep`, "");
  sftp.writeFile(`${DATA}/Lua/panelbridge/servertest/status.json`, "{}");
  _setFileManagerSftpTestHooks({ clientFactory: sftp.clientFactory });
  dbState.servers = [{ id: "r1", name: "Remote", serverName: "servertest", isActive: true, provider: "remote-sftp", isRemote: true }];
  dbState.settings = {
    panelBridgeSftpHost: "sftp.test",
    panelBridgeSftpPort: 2222,
    panelBridgeSftpUsername: "pz",
    panelBridgeSftpPassword: "fake-sftp-password",
    panelBridgeSftpConfigPath: `${DATA}/Server`,
    panelBridgeSftpBridgePath: `${DATA}/Lua/panelbridge/servertest`,
  };
  invalidateRootCache();
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  _resetZipSlotsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(async () => {
  await closeFileManagerSftpPool();
  _setFileManagerSftpTestHooks();
});

const BOTH = ["Logs/Readme.txt", "Logs/README.txt"];

describe("two remote files whose names differ only in case, selected together", () => {
  it("both go to Trash", async () => {
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: BOTH }, user);
    expect(preview.items.map((item) => item.path)).toEqual(BOTH);
    expect(preview.totals.files).toBe(2);
    const result = await service.deleteItems(await ctx(), { root: "data", previewId: preview.previewId, mode: "trash", confirm: preview.required }, user, audit());
    expect(result.body.failed).toEqual([]);
    expect(result.body.trashed.map((item) => item.path).sort()).toEqual([...BOTH].sort());
    expect(sftp.readFile(`${DATA}/Logs/Readme.txt`)).toBeNull();
    expect(sftp.readFile(`${DATA}/Logs/README.txt`)).toBeNull();
  });

  it("both move", async () => {
    const result = await service.moveEntries(await ctx(), { root: "data", paths: BOTH, destDir: "dest", confirm: [] }, user, audit());
    expect(result.failed).toEqual([]);
    expect(result.moved).toHaveLength(2);
    expect(sftp.readFile(`${DATA}/dest/Readme.txt`)?.toString()).toBe("one\n");
    expect(sftp.readFile(`${DATA}/dest/README.txt`)?.toString()).toBe("two, a different file\n");
  });

  it("both are in the zip", async () => {
    const zip = await service.prepareZip(await ctx(), { root: "data", paths: BOTH }, user, audit());
    const res = new PassThrough();
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    try {
      await zip.stream(res);
    } finally {
      zip.release();
    }
    const archive = await unzipper.Open.buffer(Buffer.concat(chunks));
    // Top-level names stay distinct for an extractor that folds case
    // ("README (2).txt"); what matters is that both files are there.
    expect(archive.files).toHaveLength(2);
    const contents = await Promise.all(archive.files.map(async (file) => (await file.buffer()).toString()));
    expect(contents.sort()).toEqual(["one\n", "two, a different file\n"]);
  });

  it("a folder moves into a different folder whose name differs only in case", async () => {
    sftp.writeFile(`${DATA}/Mods/a.lua`, "a\n");
    sftp.writeFile(`${DATA}/mods/x/.keep`, "");
    const result = await service.moveEntries(await ctx(), { root: "data", paths: ["Mods"], destDir: "mods/x", confirm: [] }, user, audit());
    expect(result.failed).toEqual([]);
    expect(sftp.readFile(`${DATA}/mods/x/Mods/a.lua`)?.toString()).toBe("a\n");
  });

  it("a folder and a file inside it are still one item", async () => {
    sftp.writeFile(`${DATA}/Logs/old/older.txt`, "older\n");
    const preview = await service.deletePreview(await ctx(), { root: "data", paths: ["Logs/old", "Logs/old/older.txt"] }, user);
    expect(preview.items.map((item) => item.path)).toEqual(["Logs/old"]);
  });
});
