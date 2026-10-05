import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, H4 round 3 (verifier): panelBridge:status and
// panelBridge:configured go to sockets holding bridge.setup or
// bridge.diagnostics, and carried the bridge folder to both. A custom role
// holding only bridge.diagnostics gets that folder as the placeholder from
// GET /api/servers and now GET /api/panel-bridge/status; the events follow.

const roles = new Map();

vi.mock("../database/init.js", () => ({
  getDb: vi.fn(async () => ({ data: { users: [] } })),
  commitNow: vi.fn(async () => {}),
  peekServerDisplayName: vi.fn(() => null),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  flushWrites: vi.fn(async () => {}),
  getRoles: async () => [...roles.values()],
  getRoleById: async (id) => [...roles.values()].find((r) => r.id === id) || null,
  getRoleByName: async (name) => roles.get(name) || null,
  getUsersForRole: async () => [],
}));

const { io } = await import("../index.js");
const { default: panelBridge } = await import("../services/panelBridge.js");
const { HIDDEN_HOST_PATH } = await import("../utils/hostPathView.js");

const BRIDGE_DIR = "/srv/pz-h4-bridge/Zomboid/Lua/ZCPB";

function fakeSocket(id, role) {
  return { id, user: { userId: id, username: id, role }, rooms: new Set([id]), emit: vi.fn() };
}

const added = [];
function connect(socket) {
  io.sockets.sockets.set(socket.id, socket);
  added.push(socket.id);
  return socket;
}

let previousBridgePath;

beforeEach(() => {
  roles.clear();
  roles.set("BridgeDiag", { id: "r1", name: "BridgeDiag", capabilities: ["bridge.diagnostics"] });
  roles.set("BridgeSetup", { id: "r2", name: "BridgeSetup", capabilities: ["bridge.setup"] });
  roles.set("Moderator", { id: "r3", name: "Moderator", capabilities: ["players.view"] });
  previousBridgePath = panelBridge.bridgePath;
  panelBridge.bridgePath = BRIDGE_DIR;
});

afterEach(() => {
  for (const id of added.splice(0)) io.sockets.sockets.delete(id);
  panelBridge.bridgePath = previousBridgePath;
});

// The two status events are sent concurrently; their order is not the point.
const sortByRunning = (payloads) => [...payloads].sort((a, b) => Number(b.isRunning) - Number(a.isRunning));

async function deliveredTo(socket, event) {
  await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith(event, expect.anything()));
  return socket.emit.mock.calls.filter(([name]) => name === event).map(([, payload]) => payload);
}

describe("panelBridge:status and panelBridge:configured", () => {
  it("give a socket that only diagnoses the bridge the placeholder, and the setup role the folder", async () => {
    const diag = connect(fakeSocket("h4-diag", "BridgeDiag"));
    const setup = connect(fakeSocket("h4-setup", "BridgeSetup"));
    const moderator = connect(fakeSocket("h4-mod", "Moderator"));

    panelBridge.emit("configured", { path: BRIDGE_DIR });
    panelBridge.emit("started");
    panelBridge.emit("stopped");

    expect(await deliveredTo(setup, "panelBridge:configured")).toEqual([{ bridgePath: BRIDGE_DIR }]);
    expect(await deliveredTo(diag, "panelBridge:configured")).toEqual([{ bridgePath: HIDDEN_HOST_PATH }]);
    await vi.waitFor(() => expect(diag.emit.mock.calls.filter(([name]) => name === "panelBridge:status")).toHaveLength(2));
    expect(sortByRunning(await deliveredTo(diag, "panelBridge:status"))).toEqual([
      { isRunning: true, bridgePath: HIDDEN_HOST_PATH },
      { isRunning: false, bridgePath: HIDDEN_HOST_PATH },
    ]);
    await vi.waitFor(() => expect(setup.emit.mock.calls.filter(([name]) => name === "panelBridge:status")).toHaveLength(2));
    expect(sortByRunning(await deliveredTo(setup, "panelBridge:status"))).toEqual([
      { isRunning: true, bridgePath: BRIDGE_DIR },
      { isRunning: false, bridgePath: BRIDGE_DIR },
    ]);
    expect(moderator.emit).not.toHaveBeenCalled();
  });
});
