import { afterEach, describe, expect, it, vi } from "vitest";

// POST /character/import (a restore from a saved export) levels skills and
// adds items through the bridge. It logs an "import" player action, so the
// player's history shows it and the Character tab's "Worth a look" can say
// the restored skills and items came from the panel
// (services/characterHints.js). A failed log line doesn't fail the import.
// Same getHandler/runHandler pattern as panelBridgeImportSnapshotCollision.test.js.
const logPlayerAction = vi.fn(async () => ({}));
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
  logPlayerAction: (...args) => logPlayerAction(...args),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runImport(body) {
  const layer = router.stack.find((entry) => entry.route?.path === "/character/import" && entry.route.methods.post);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle({ body }, res, () => {});
  return res;
}

function bridgeAnswers(importResult) {
  bridge.isRunning = true;
  vi.spyOn(bridge, "sendCommand").mockImplementation(async (action) => {
    if (action === "exportPlayerData") return { success: true, data: { perks: {} } };
    if (action === "importPlayerData") return importResult();
    throw new Error(`unexpected bridge action: ${action}`);
  });
}

describe("POST /character/import: player log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logPlayerAction.mockReset();
    logPlayerAction.mockImplementation(async () => ({}));
    bridge.isRunning = false;
  });

  it("logs an import with what the bridge restored", async () => {
    bridgeAnswers(async () => ({ success: true, data: { message: "Player data imported", restored: { perks: 8, items: 40 } } }));
    const res = await runImport({ username: "Vet", data: { perks: { Woodwork: { level: 8 } } } });
    expect(res.status).not.toHaveBeenCalled();
    expect(logPlayerAction).toHaveBeenCalledWith("Vet", "import", "perks=8 items=40");
  });

  it("logs nothing when the import failed", async () => {
    bridgeAnswers(async () => {
      throw new Error("Player not found: Vet");
    });
    const res = await runImport({ username: "Vet", data: { perks: {} } });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(logPlayerAction).not.toHaveBeenCalled();
  });

  it("still answers success when the log line can't be written", async () => {
    bridgeAnswers(async () => ({ success: true, data: { restored: { perks: 1, items: 0 } } }));
    logPlayerAction.mockRejectedValue(new Error("disk full"));
    const res = await runImport({ username: "Vet", data: { perks: {} } });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
