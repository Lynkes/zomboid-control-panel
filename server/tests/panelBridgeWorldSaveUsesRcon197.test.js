import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

// #197: POST /panel-bridge/world/save sent the bridge's saveWorld, which ran
// the Lua global saveGame(). On a dedicated server that is the single-player
// save path, and it writes map_sand.bin, a copy of every sandbox option the
// game applies over SandboxVars.lua on every start. The route now runs the
// server's own `save` over RCON, and the /command passthrough no longer
// accepts saveWorld.

const { default: router, VALID_ACTIONS } = await import("../routes/panelBridge.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("POST /panel-bridge/world/save (#197)", () => {
  it("runs the server's own save over RCON, bridge or no bridge", async () => {
    const rconService = { save: vi.fn().mockResolvedValue({ success: true, response: "World saved" }) };
    const res = createResponse();

    await getHandler("/world/save", "post")({ app: { get: () => rconService } }, res);

    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, response: "World saved" });
  });

  it("is no longer an action the panel will send to the bridge", () => {
    expect(VALID_ACTIONS.has("saveWorld")).toBe(false);
  });
});
