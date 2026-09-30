import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  IS_WIN,
  canSymlinkFiles,
  fakeApp,
  linkDir,
  linkFile,
  makeServerTree,
  makeTempDir,
  removeDir,
  write,
} from "./helpers/fileManagerFixtures.js";

// Containment for the local Server Files backend (spec §A4.3): links that
// leave a root are refused (or, for delete/rename/move of the link itself,
// acted on without following), links that stay inside work, a hard link to
// a panel secret is refused by inode, and the "too broad" and "overlaps the
// panel" root rules. The canary file outside the root must never show up in
// any response.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
  };
});

const { localBackend, isTooBroad } = await import("../services/fileManagerLocalBackend.js");
const { buildProtectionContext } = await import("../services/fileManagerProtectedAreas.js");
const service = await import("../services/fileManagerService.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _setRunStateDepsForTests } = await import("../services/fileManagerRunState.js");
const { getDataPaths } = await import("../utils/paths.js");
const { FmError } = await import("../services/fileManagerContract.js");

let base;
let tree;

async function describeRootAt(id, p) {
  return localBackend.describeRoot({ id, path: p });
}

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    if (!(err instanceof FmError)) throw err;
    return err.code;
  }
}

async function ctx() {
  return service.loadProfileContext(tree.profile.id, fakeApp());
}

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  invalidateRootCache();
  _setRunStateDepsForTests({});
});

afterEach(() => {
  removeDir(base);
});

describe("links that leave the root", () => {
  it("a folder link to outside is refused for list and read, and the canary never appears", async () => {
    linkDir(tree.outside, path.join(tree.data, "escape"));
    const root = await describeRootAt("data", tree.data);
    expect(await codeOf(localBackend.resolve(root, ["escape"], "list"))).toBe("FM_LINK_ESCAPES_ROOT");
    expect(await codeOf(localBackend.resolve(root, ["escape", "canary.txt"], "read"))).toBe("FM_LINK_ESCAPES_ROOT");

    const c = await ctx();
    const listing = await service.listDir(c, { root: "data", path: "" });
    const row = listing.entries.find((e) => e.name === "escape");
    expect(row.type).toBe("link");
    expect(row.link).toEqual({ inside: false, targetType: "unknown" });
    const responses = [listing];
    for (const call of [
      () => service.readText(c, { root: "data", path: "escape/canary.txt" }),
      () => service.listDir(c, { root: "data", path: "escape" }),
      () => service.statPath(c, { root: "data", path: "escape/canary.txt" }),
    ]) {
      const code = await codeOf(call());
      expect(code).toBe("FM_LINK_ESCAPES_ROOT");
    }
    responses.push(await service.search(c, { root: "data", path: "", q: "canary" }));
    const text = JSON.stringify(responses);
    expect(text).not.toContain("CANARY");
    expect(text).not.toContain("canary.txt");
    expect(text).not.toContain(tree.outside);
  });

  it.skipIf(!canSymlinkFiles())("a file link to outside is refused", async () => {
    linkFile(path.join(tree.outside, "canary.txt"), path.join(tree.data, "leak.txt"));
    const c = await ctx();
    expect(await codeOf(service.readText(c, { root: "data", path: "leak.txt" }))).toBe("FM_LINK_ESCAPES_ROOT");
    expect(await codeOf(service.openDownload(c, { root: "data", path: "leak.txt" }, { userId: "u1" }, {}))).toBe(
      "FM_LINK_ESCAPES_ROOT",
    );
  });

  it("delete of an escaping link acts on the link itself and never touches the target", async () => {
    linkDir(tree.outside, path.join(tree.data, "escape"));
    const root = await describeRootAt("data", tree.data);
    const r = await localBackend.resolve(root, ["escape"], "delete");
    expect(r.linkSelf).toBe(true);
    expect(r.stat.type).toBe("link");
    await localBackend.deletePermanent(r, () => {});
    expect(fs.existsSync(path.join(tree.data, "escape"))).toBe(false);
    expect(fs.readFileSync(path.join(tree.outside, "canary.txt"), "utf8")).toBe("CANARY-OUTSIDE-ROOT");
  });

  it("the permanent walker removes a link inside a folder without entering it", async () => {
    const doomed = path.join(tree.data, "doomed");
    write(path.join(doomed, "a.txt"), "a");
    linkDir(tree.outside, path.join(doomed, "inner-link"));
    const root = await describeRootAt("data", tree.data);
    const r = await localBackend.resolve(root, ["doomed"], "delete");
    await localBackend.deletePermanent(r, () => {});
    expect(fs.existsSync(doomed)).toBe(false);
    expect(fs.readFileSync(path.join(tree.outside, "canary.txt"), "utf8")).toBe("CANARY-OUTSIDE-ROOT");
  });

  it.skipIf(!IS_WIN)("a junction to outside: refused to enter, and a delete removes only the junction", async () => {
    const junction = path.join(tree.data, "Junction");
    fs.symlinkSync(tree.outside, junction, "junction");
    const c = await ctx();
    expect(await codeOf(service.listDir(c, { root: "data", path: "Junction" }))).toBe("FM_LINK_ESCAPES_ROOT");
    const preview = await service.deletePreview(c, { root: "data", paths: ["Junction"] }, { userId: "u1" });
    expect(preview.items[0].type).toBe("link");
    const audit = { defer: () => ({ finish: async () => {} }) };
    const result = await service.deleteItems(
      c,
      { root: "data", previewId: preview.previewId, mode: "trash", confirm: [] },
      { userId: "u1", username: "kate" },
      audit,
    );
    expect(result.body.trashed).toHaveLength(1);
    expect(fs.existsSync(junction)).toBe(false);
    expect(fs.readFileSync(path.join(tree.outside, "canary.txt"), "utf8")).toBe("CANARY-OUTSIDE-ROOT");
  });
});

describe("links that stay inside", () => {
  it("inside-to-inside folder links work, chained links too", async () => {
    linkDir(path.join(tree.data, "Server"), path.join(tree.data, "cfg"));
    linkDir(path.join(tree.data, "cfg"), path.join(tree.data, "cfg2"));
    const c = await ctx();
    const text = await service.readText(c, { root: "data", path: "cfg2/servertest_SandboxVars.lua" });
    expect(text.content).toBe("SandboxVars = {}\n");
    const listing = await service.listDir(c, { root: "data", path: "" });
    const row = listing.entries.find((e) => e.name === "cfg");
    expect(row.link).toEqual({ inside: true, targetType: "dir" });
  });

  it("a broken link lists as missing and can't be read", async () => {
    const target = path.join(tree.data, "gone");
    fs.mkdirSync(target);
    linkDir(target, path.join(tree.data, "dangling"));
    fs.rmdirSync(target);
    const c = await ctx();
    const listing = await service.listDir(c, { root: "data", path: "" });
    expect(listing.entries.find((e) => e.name === "dangling").link.targetType).toBe("missing");
    expect(await codeOf(service.listDir(c, { root: "data", path: "dangling" }))).toBe("FM_NOT_FOUND");
  });

  it("a link inside the root pointing into a protected folder is protected too", async () => {
    linkDir(path.join(tree.data, "backups"), path.join(tree.data, "shortcut"));
    const c = await ctx();
    expect(await codeOf(service.readText(c, { root: "data", path: "shortcut/world-1.zip" }))).toBe("FM_PATH_PROTECTED");
    const listing = await service.listDir(c, { root: "data", path: "" });
    expect(listing.entries.find((e) => e.name === "shortcut").protection).toEqual({
      level: "listOnly",
      area: "panelBackups",
    });
  });
});

describe("names", () => {
  it("a literal %2e%2e is an ordinary name, never a parent step", async () => {
    write(path.join(tree.data, "%2e%2e"), "literal");
    const c = await ctx();
    const text = await service.readText(c, { root: "data", path: "%2e%2e" });
    expect(text.content).toBe("literal");
  });

  it("dot segments, separators, drive letters and streams never reach the filesystem", async () => {
    const c = await ctx();
    for (const bad of ["..", "a/../..", "../outside/canary.txt", "C:/Windows", "a\\..\\b", "file.txt:stream", "/abs"]) {
      expect(await codeOf(service.readText(c, { root: "data", path: bad }))).toBe("FM_INVALID_PATH");
    }
  });

  it("the Trash folder and panel temp files are reachable only through the Trash routes", async () => {
    write(path.join(tree.data, ".zcp-trash", "x.txt"), "trash");
    write(path.join(tree.data, "a.txt.zcpupload"), "temp");
    const c = await ctx();
    expect(await codeOf(service.listDir(c, { root: "data", path: ".zcp-trash" }))).toBe("FM_INVALID_PATH");
    expect(await codeOf(service.listDir(c, { root: "data", path: ".ZCP-TRASH" }))).toBe("FM_INVALID_PATH");
    expect(await codeOf(service.readText(c, { root: "data", path: "a.txt.zcpupload" }))).toBe("FM_INVALID_PATH");
    const listing = await service.listDir(c, { root: "data", path: "" });
    const names = listing.entries.map((e) => e.name);
    expect(names).not.toContain(".zcp-trash");
    expect(names).not.toContain("a.txt.zcpupload");
  });

  it.skipIf(!IS_WIN)("a case variant of backups is still the list-only backups folder", async () => {
    const c = await ctx();
    expect(await codeOf(service.readText(c, { root: "data", path: "BACKUPS/world-1.zip" }))).toBe("FM_PATH_PROTECTED");
    const listing = await service.listDir(c, { root: "data", path: "BACKUPS" });
    expect(listing.dir.protection).toEqual({ level: "listOnly", area: "panelBackups" });
  });
});

describe("panel secrets by inode", () => {
  it("a hard link to the panel's jwt.secret is refused wherever it sits", async () => {
    const { dataDir } = getDataPaths();
    const secret = write(path.join(dataDir, "jwt.secret"), "SECRET-JWT-VALUE");
    const alias = path.join(tree.data, "Server", "innocent.txt");
    fs.linkSync(secret, alias);
    const c = await ctx();
    const err = await service.readText(c, { root: "data", path: "Server/innocent.txt" }).catch((e) => e);
    expect(err.code).toBe("FM_PATH_PROTECTED");
    expect(err.params).toMatchObject({ area: "panelSecret", level: "sealed" });
    const listing = await service.listDir(c, { root: "data", path: "Server" });
    const row = listing.entries.find((e) => e.name === "innocent.txt");
    expect(row.protection).toEqual({ level: "sealed", area: "panelSecret" });
    expect(row.size).toBeNull();
    expect(JSON.stringify(listing)).not.toContain("SECRET-JWT-VALUE");
  });
});

describe("root rules", () => {
  it("drive roots, home and its ancestors, system folders and the broad shared folders are too broad", () => {
    const home = os.homedir();
    expect(isTooBroad(path.parse(home).root)).toBe(true);
    expect(isTooBroad(home)).toBe(true);
    expect(isTooBroad(path.dirname(home))).toBe(true);
    if (IS_WIN) {
      expect(isTooBroad("C:\\")).toBe(true);
      expect(isTooBroad("C:\\Program Files")).toBe(true);
      expect(isTooBroad("c:\\program files\\")).toBe(true);
      expect(isTooBroad("C:\\Users")).toBe(true);
      expect(isTooBroad("C:\\Windows\\System32")).toBe(true);
      expect(isTooBroad("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Project Zomboid Dedicated Server")).toBe(false);
      expect(isTooBroad("D:\\Servers\\pz")).toBe(false);
    } else {
      expect(isTooBroad("/")).toBe(true);
      expect(isTooBroad("/opt")).toBe(true);
      expect(isTooBroad("/etc/pz")).toBe(true);
      expect(isTooBroad("/opt/pz")).toBe(false);
      expect(isTooBroad("/usr/local/pz")).toBe(false);
      expect(isTooBroad("/var/lib/pz")).toBe(false);
    }
  });

  it("a root that contains the panel's data folder seals that subtree", async () => {
    const { dataDir, logsDir } = getDataPaths();
    const around = path.dirname(dataDir);
    const root = await describeRootAt("data", around);
    expect(root.available).toBe(true);
    const rules = buildProtectionContext({ rootId: "data", rootReal: root.real, profiles: [], settings: {} });
    const dataRel = path.relative(root.real, fs.realpathSync.native(dataDir)).split(path.sep).join("/");
    expect(rules.classify(`${dataRel}/db.json`)).toEqual({ level: "sealed", area: "panelData" });
    const logsRel = path.relative(root.real, fs.realpathSync.native(logsDir)).split(path.sep).join("/");
    expect(rules.classify(logsRel)).toEqual({ level: "sealed", area: "panelLogs" });
    expect(rules.protectedWithin("")).not.toBeNull();
  });

  it("a sealed folder inside a root can't be probed: existing or not, the answer is the same", async () => {
    const { dataDir } = getDataPaths();
    write(path.join(dataDir, "jwt.secret"), "SECRET");
    const around = fs.realpathSync.native(path.dirname(dataDir));
    const dataName = path.basename(dataDir);
    dbState.servers = [{ ...tree.profile, zomboidDataPath: around, serverConfigPath: "" }];
    invalidateRootCache();
    const c = await ctx();
    const listing = await service.listDir(c, { root: "data", path: "" });
    const row = listing.entries.find((e) => e.name === dataName);
    expect(row.protection).toEqual({ level: "sealed", area: "panelData" });
    expect(row.size).toBeNull();
    expect(row.modifiedAt).toBeNull();
    for (const probe of [`${dataName}/jwt.secret`, `${dataName}/does-not-exist`, `${dataName}/a/b/c`]) {
      expect(await codeOf(service.statPath(c, { root: "data", path: probe })), probe).toBe("FM_PATH_PROTECTED");
      expect(await codeOf(service.readText(c, { root: "data", path: probe })), probe).toBe("FM_PATH_PROTECTED");
    }
    expect(await codeOf(service.listDir(c, { root: "data", path: dataName }))).toBe("FM_PATH_PROTECTED");
    const found = await service.search(c, { root: "data", path: "", q: "jwt" });
    expect(found.results).toEqual([]);
  });

  it("a root inside the panel's own folders is refused as overlapsPanel", async () => {
    const { dataDir } = getDataPaths();
    const inner = path.join(dataDir, "inner-root");
    fs.mkdirSync(inner, { recursive: true });
    const root = await describeRootAt("data", inner);
    expect(root.available).toBe(false);
    expect(root.unavailableReason).toBe("overlapsPanel");
  });

  it("relative, missing and file roots are unavailable with the right reason", async () => {
    expect((await describeRootAt("data", "relative/path")).unavailableReason).toBe("notConfigured");
    expect((await describeRootAt("data", path.join(base, "nope"))).unavailableReason).toBe("missing");
    expect((await describeRootAt("data", path.join(tree.install, "ProjectZomboid64.json"))).unavailableReason).toBe(
      "missing",
    );
  });
});
