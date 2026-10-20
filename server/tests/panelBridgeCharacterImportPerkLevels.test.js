import { afterEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-20): POST /character/import handed the file's perk
// levels to the bridge as they were, and PanelBridge levelled each perk once
// per level: a level of 1e9 froze the game server. The panel now refuses a
// perk level that is not a whole number from 0 to 10 (the bridge clamps it
// too, panelBridgeImportPlayerDataClamps.test.js), before it snapshots or
// sends anything. POST /command's importPlayerData gets the same check.
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
  logPlayerAction: vi.fn(async () => ({})),
  getRoleByName: vi.fn(async () => ({ capabilities: ["bridge.command", "players.gm_tools"] })),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function post(path, body) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods.post);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { body, user: { username: "gm", role: "admin" } },
    res,
    () => {},
  );
  return res;
}

let sent;
function bridgeAnswers() {
  sent = [];
  bridge.isRunning = true;
  bridge.bridgePath = bridge.bridgePath || "/tmp/bridge";
  vi.spyOn(bridge, "sendCommand").mockImplementation(async (action, args) => {
    sent.push({ action, args });
    if (action === "exportPlayerData") return { success: true, data: { perks: {} } };
    return { success: true, data: { restored: { perks: 1, items: 0 } } };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  bridge.isRunning = false;
});

const BAD_PERKS = [
  ["a huge level", { Fitness: { level: 1e9 } }],
  ["a negative level", { Fitness: { level: -1 } }],
  ["level 11", { Fitness: { level: 11 } }],
  ["a fractional level", { Fitness: { level: 2.5 } }],
  ["a level as text", { Fitness: { level: "5" } }],
  ["a level of Infinity's JSON stand-in", { Fitness: { level: Number.MAX_VALUE } }],
  ["an entry that is not an object", { Fitness: 5 }],
  ["perks as a list", [{ level: 3 }]],
  ["perks as text", "Fitness"],
];

describe("POST /character/import refuses perk levels the game can't have", () => {
  it.each(BAD_PERKS)("refuses %s and sends nothing to the bridge", async (_label, perks) => {
    bridgeAnswers();
    const res = await post("/character/import", { username: "Vet", data: { perks } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.PANELBRIDGE_CHARACTER_PERK_INVALID }),
    );
    expect(sent).toEqual([]);
  });

  it("imports levels 0 to 10, a perk with no level, and a file with no perks", async () => {
    bridgeAnswers();
    const perks = { Fitness: { level: 0, xp: 0 }, Strength: { level: 10, xp: 75000.5 }, Cooking: {} };
    const res = await post("/character/import", { username: "Vet", data: { perks } });
    expect(res.status).not.toHaveBeenCalled();
    expect(sent.map((s) => s.action)).toEqual(["exportPlayerData", "importPlayerData"]);
    expect(sent[1].args.data.perks).toEqual(perks);

    bridgeAnswers();
    const noPerks = await post("/character/import", { username: "Vet", data: { inventory: [] } });
    expect(noPerks.status).not.toHaveBeenCalled();
  });
});

describe("POST /command importPlayerData gets the same check", () => {
  it("refuses a huge perk level", async () => {
    bridgeAnswers();
    const res = await post("/command", {
      action: "importPlayerData",
      args: { username: "Vet", data: { perks: { Fitness: { level: 1e9 } } } },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.PANELBRIDGE_CHARACTER_PERK_INVALID }),
    );
    expect(sent).toEqual([]);
  });
});
