import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fakeApp, makeServerTree, makeTempDir, removeDir } from "./helpers/fileManagerFixtures.js";

// Every name and path rule of spec §A4.2, driven by the shared fixture
// (the same one client/src/components/files/nameRules.ts is tested
// against): the contract's validators give the fixture's reason, and the
// service refuses the same input with FM_INVALID_PATH / FM_INVALID_NAME and
// that reason before touching the disk.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "fileManagerNameCases.json"), "utf8"));

const dbState = vi.hoisted(() => ({ servers: [] }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => ({}),
  };
});

const { validateName, validateSegments, NAME_RULE_REASONS, FmError } = await import("../services/fileManagerContract.js");
const service = await import("../services/fileManagerService.js");

let base;
let tree;

beforeAll(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
});

afterAll(() => {
  removeDir(base);
});

function label(c) {
  const shown = c.input.length > 40 ? `${c.input.slice(0, 40)}... (${c.input.length} chars)` : c.input;
  return `${c.kind} ${JSON.stringify(shown)} -> ${c.reason ?? "ok"}`;
}

async function errorOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof FmError) return err;
    throw err;
  }
}

describe("the fixture", () => {
  it("covers every reason", () => {
    const reasons = new Set(cases.map((c) => c.reason).filter(Boolean));
    for (const reason of NAME_RULE_REASONS) expect(reasons.has(reason), reason).toBe(true);
  });

  it.each(cases.map((c) => [label(c), c]))("%s", (_label, c) => {
    const result = c.kind === "path" ? validateSegments(c.input) : validateName(c.input, { isNew: c.kind === "newName" });
    expect(result.ok ? null : result.reason).toBe(c.reason);
  });
});

describe("the service applies the same rules", () => {
  const user = { userId: "u1", username: "kate" };
  const audit = () => ({ defer: () => ({ finish: async () => {} }) });

  it.each(cases.filter((c) => c.kind === "path" && c.reason).map((c) => [label(c), c]))("path %s", async (_label, c) => {
    const ctx = await service.loadProfileContext("p1", fakeApp());
    const err = await errorOf(service.listDir(ctx, { root: "data", path: c.input }));
    expect(err?.code).toBe("FM_INVALID_PATH");
    expect(err.params.reason).toBe(c.reason);
  });

  it.each(cases.filter((c) => c.kind === "newName" && c.reason).map((c) => [label(c), c]))("new name %s", async (_label, c) => {
    const ctx = await service.loadProfileContext("p1", fakeApp());
    const err = await errorOf(service.makeDirectory(ctx, { root: "data", path: "", name: c.input, confirm: [] }, user, audit()));
    expect(err?.code).toBe("FM_INVALID_NAME");
    expect(err.params.reason).toBe(c.reason);
  });

  it("names the contract allows in a path but the panel owns are refused as reservedPanelName", async () => {
    const ctx = await service.loadProfileContext("p1", fakeApp());
    for (const p of [".zcp-trash", ".zcp-trash/x", "Server/x.zcpupload", "a.ZCPTMP"]) {
      const err = await errorOf(service.statPath(ctx, { root: "data", path: p }));
      expect(err?.code, p).toBe("FM_INVALID_PATH");
      expect(err.params.reason).toBe("reservedPanelName");
    }
  });

  it("non-string paths are a bad request, not a path", async () => {
    const ctx = await service.loadProfileContext("p1", fakeApp());
    expect((await errorOf(service.listDir(ctx, { root: "data", path: ["a"] })))?.code).toBe("FM_INVALID_REQUEST");
  });
});
