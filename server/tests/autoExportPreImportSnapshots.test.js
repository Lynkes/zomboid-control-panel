import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { autoExportPlayer } from "../index.js";
import { getDataPaths } from "../utils/paths.js";
import { encodeExportFolderName } from "../utils/exportFolderName.js";
import { setSetting } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";

// The character import route writes a recovery copy of the player's current
// data (<name>_pre-import_<timestamp>.json, routes/panelBridge.js) into the
// same exports/<player>/ folder the login auto-export rotates. The rotation
// counted every .json and sorted by name: "Bob_pre-import_..." sorts above
// every "Bob_2026-..." ('p' > '2'), so once a player had as many recovery
// copies as the keep-count, each login wrote Bob_<now>.json and deleted it in
// the same pass, and older recovery copies were deleted like auto-exports.

function exportDirFor(username) {
  const { dataDir } = getDataPaths();
  return path.join(dataDir, "exports", encodeExportFolderName(username));
}

function freezeClock(isoString) {
  const fixedNow = new Date(isoString);
  const realToISOString = Date.prototype.toISOString;
  return vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
    return realToISOString.call(fixedNow);
  });
}

function mockConnectedBridge() {
  panelBridge.isRunning = true;
  vi.spyOn(panelBridge, "isModConnected").mockReturnValue(true);
  vi.spyOn(panelBridge, "sendCommand").mockResolvedValue({ success: true, data: { ok: true } });
}

function seed(dir, names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), "{}");
}

afterEach(() => {
  vi.restoreAllMocks();
  panelBridge.isRunning = false;
});

describe("autoExportPlayer rotation leaves pre-import recovery copies alone", () => {
  it("keeps the export it just wrote when the folder holds more recovery copies than the keep-count", async () => {
    await setSetting("autoExportMaxPerPlayer", 3);
    const dir = exportDirFor("Bob");
    const recoveryCopies = [
      "Bob_pre-import_2026-10-01T10-00-00-000Z.json",
      "Bob_pre-import_2026-10-02T10-00-00-000Z.json",
      "Bob_pre-import_2026-10-03T10-00-00-000Z.json",
      "Bob_pre-import_2026-10-04T10-00-00-000Z-2.json",
    ];
    seed(dir, recoveryCopies);
    mockConnectedBridge();
    freezeClock("2026-10-20T12:00:00.000Z");

    await autoExportPlayer("Bob");

    const files = fs.readdirSync(dir).sort();
    expect(files).toContain("Bob_2026-10-20T12-00-00-000Z.json");
    for (const copy of recoveryCopies) expect(files).toContain(copy);
  });

  it("rotates only the auto-exports, newest kept, and never counts the recovery copies", async () => {
    await setSetting("autoExportMaxPerPlayer", 2);
    const dir = exportDirFor("Carol");
    seed(dir, [
      "Carol_2026-10-01T09-00-00-000Z.json",
      "Carol_pre-import_2026-10-01T08-00-00-000Z.json",
      "unrelated-note.json",
    ]);
    mockConnectedBridge();

    const clock = freezeClock("2026-10-10T09:00:00.000Z");
    await autoExportPlayer("Carol");
    clock.mockRestore();
    freezeClock("2026-10-11T09:00:00.000Z");
    await autoExportPlayer("Carol");

    expect(fs.readdirSync(dir).sort()).toEqual([
      "Carol_2026-10-10T09-00-00-000Z.json",
      "Carol_2026-10-11T09-00-00-000Z.json",
      "Carol_pre-import_2026-10-01T08-00-00-000Z.json",
      "unrelated-note.json",
    ]);
  });
});
