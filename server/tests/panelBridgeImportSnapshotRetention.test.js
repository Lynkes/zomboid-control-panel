import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDataPaths } from "../utils/paths.js";
import { encodeExportFolderName } from "../utils/exportFolderName.js";
import { prunePreImportSnapshots } from "../utils/preImportSnapshots.js";

// Audit 2026-10-20: every POST /character/import writes a full export of the
// player's current data first (the recovery copy), and nothing removed them:
// the only rotation in that folder runs on the player's next login. The
// route now keeps the newest N pre-import snapshots of the player (N = the
// auto-export "keep" setting, else 5) and never touches an auto-export.

const getAllSettings = vi.fn(async () => ({}));
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: (...args) => getAllSettings(...args),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
  logPlayerAction: vi.fn(async () => {}),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function getHandler(routePath, method) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function runImport(username) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await getHandler("/character/import", "post")({ body: { username, data: { perks: {} } } }, res, () => {});
  return res;
}

const stamp = (day) => `2026-09-${String(day).padStart(2, "0")}T10-00-00-000Z`;

describe("POST /character/import: pre-import snapshot retention", () => {
  let exportDir;
  const username = "RetentionUser";

  beforeEach(() => {
    bridge.isRunning = true;
    vi.spyOn(bridge, "sendCommand").mockImplementation(async (action) => {
      if (action === "exportPlayerData") return { success: true, data: { perks: { Fitness: 1 } } };
      if (action === "importPlayerData") return { success: true };
      throw new Error(`unexpected bridge action: ${action}`);
    });
    exportDir = path.join(getDataPaths().dataDir, "exports", encodeExportFolderName(username));
    fs.rmSync(exportDir, { recursive: true, force: true });
    fs.mkdirSync(exportDir, { recursive: true });
    // Seven older recovery copies, two login auto-exports, one stray file.
    for (let day = 1; day <= 7; day++) fs.writeFileSync(path.join(exportDir, `${username}_pre-import_${stamp(day)}.json`), "{}");
    fs.writeFileSync(path.join(exportDir, `${username}_${stamp(1)}.json`), "{}");
    fs.writeFileSync(path.join(exportDir, `${username}_${stamp(2)}.json`), "{}");
    fs.writeFileSync(path.join(exportDir, "notes.txt"), "mine");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    getAllSettings.mockReset().mockResolvedValue({});
    bridge.isRunning = false;
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  const preImports = () => fs.readdirSync(exportDir).filter((f) => f.includes("_pre-import_")).sort();

  it("keeps the newest 5 when no auto-export setting is saved, the new one included", async () => {
    const res = await runImport(username);
    expect(res.status).not.toHaveBeenCalled();
    const { snapshotFile } = res.json.mock.calls[0][0];

    const kept = preImports();
    expect(kept).toHaveLength(5);
    expect(kept).toContain(snapshotFile);
    expect(kept).not.toContain(`${username}_pre-import_${stamp(1)}.json`);
    expect(kept).not.toContain(`${username}_pre-import_${stamp(3)}.json`);
    expect(kept).toContain(`${username}_pre-import_${stamp(4)}.json`);
    // Auto-exports and other files are untouched.
    expect(fs.existsSync(path.join(exportDir, `${username}_${stamp(1)}.json`))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, `${username}_${stamp(2)}.json`))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, "notes.txt"))).toBe(true);
  });

  it("follows the auto-export keep setting", async () => {
    getAllSettings.mockResolvedValue({ autoExportMaxPerPlayer: 2 });
    const res = await runImport(username);
    const { snapshotFile } = res.json.mock.calls[0][0];
    expect(preImports()).toEqual([`${username}_pre-import_${stamp(7)}.json`, snapshotFile].sort());
  });
});

describe("prunePreImportSnapshots", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-preimport-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("orders a collision copy after the plain one and leaves look-alikes alone", () => {
    const names = [
      `Bob_pre-import_${stamp(5)}.json`,
      `Bob_pre-import_${stamp(5)}-2.json`,
      `Bob_pre-import_${stamp(4)}.json`,
      `Bob_pre-import_notes.json`,
      `Bob_x_pre-import_${stamp(1)}.json`,
      `Bob_${stamp(1)}.json`,
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "{}");

    expect(prunePreImportSnapshots(dir, "Bob", 1).sort()).toEqual(
      [`Bob_pre-import_${stamp(4)}.json`, `Bob_pre-import_${stamp(5)}.json`].sort(),
    );
    expect(fs.readdirSync(dir).sort()).toEqual(
      [`Bob_pre-import_${stamp(5)}-2.json`, `Bob_pre-import_notes.json`, `Bob_x_pre-import_${stamp(1)}.json`, `Bob_${stamp(1)}.json`].sort(),
    );
  });
});
