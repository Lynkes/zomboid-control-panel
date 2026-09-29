import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /api/panel-bridge/install-mod-auto (Settings' Install button) answers
// from what reconcileBridge() actually did, not from the pre-check alone: a
// switch to the Workshop that lands between the check and the reconcile is
// the same 409 as one made before, a reconcile still running after the
// route's wait is not reported as a failure, and every outcome carries a
// localized code.

const server = vi.hoisted(() => ({ id: "s1", name: "Server One", serverName: "servertest", isRemote: false, installPath: "/game" }));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => server),
  getServer: vi.fn(async () => server),
  getServers: vi.fn(async () => [server]),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));
vi.mock("../services/bridgeDelivery.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getEffectiveMethod: vi.fn(() => "local"),
  reconcileBridge: vi.fn(),
}));
vi.mock("../services/panelBridgeInstaller.js", async (importOriginal) => ({
  ...(await importOriginal()),
  canAutoInstall: vi.fn(() => true),
  checkBridgeInstalled: vi.fn(() => ({ targetPath: "/game/media/lua/server/PanelBridge.lua" })),
}));

const { default: router } = await import("../routes/panelBridge.js");
const { getEffectiveMethod, reconcileBridge } = await import("../services/bridgeDelivery.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function install() {
  const layer = router.stack.find((entry) => entry.route?.path === "/install-mod-auto" && entry.route.methods.post);
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = { body: {}, user: { role: "admin" } };
  const res = createResponse();
  let index = -1;
  const next = async (err) => {
    index++;
    if (err) throw err;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await next();
  const status = res.status.mock.calls.at(-1)?.[0] ?? 200;
  return { status, body: res.json.mock.calls.at(-1)?.[0] };
}

beforeEach(() => {
  reconcileBridge.mockReset();
  getEffectiveMethod.mockReset();
  getEffectiveMethod.mockReturnValue("local");
});

describe("POST /install-mod-auto outcomes", () => {
  it("reports an install with the existing response shape", async () => {
    reconcileBridge.mockResolvedValue({ method: "local", skipped: null, actions: [{ kind: "installed" }], warnings: [] });
    expect(await install()).toEqual({
      status: 200,
      body: { success: true, message: "installed", path: "/game/media/lua/server/PanelBridge.lua", serverName: "servertest" },
    });
    // Waits less than the client's own 15 s request timeout, so a slow
    // reconcile still gets this route's coded answer to the Install button.
    expect(reconcileBridge).toHaveBeenCalledWith(server, { reason: "manual", timeoutMs: 10_000 });
  });

  // A Workshop reconcile moves loose files out and edits the ini: the Install
  // button must never be what triggers one. The post-reconcile check alone
  // would still answer 409, which is why this one pins the pre-check.
  it("409 WORKSHOP_ACTIVE without running any reconcile when the folder is already on the Workshop", async () => {
    getEffectiveMethod.mockReturnValue("workshop");
    expect(await install()).toMatchObject({
      status: 409,
      body: { code: "PANELBRIDGE_DELIVERY_WORKSHOP_ACTIVE", params: { serverName: "servertest" } },
    });
    expect(reconcileBridge).not.toHaveBeenCalled();
  });

  it("409 WORKSHOP_ACTIVE when the reconcile found the folder already switched to the Workshop", async () => {
    reconcileBridge.mockResolvedValue({ method: "workshop", skipped: null, actions: [{ kind: "archived" }], warnings: [] });
    expect(await install()).toMatchObject({
      status: 409,
      body: { code: "PANELBRIDGE_DELIVERY_WORKSHOP_ACTIVE", params: { serverName: "servertest" } },
    });
  });

  // The server's own ini loads the Workshop copy with DoLuaChecksum on:
  // reconcile keeps the loose file out, and "already up to date" would claim
  // a file that isn't there.
  it("409 WORKSHOP_ACTIVE when this server's settings load the Workshop copy with the check on", async () => {
    reconcileBridge.mockResolvedValue({ method: "local", skipped: null, actions: [], warnings: ["workshopEntriesWithChecksum"] });
    expect(await install()).toMatchObject({
      status: 409,
      body: { code: "PANELBRIDGE_DELIVERY_WORKSHOP_ACTIVE", params: { serverName: "servertest" } },
    });
  });

  it("504 STILL_RUNNING, not a failure, when the reconcile wasn't done after its timeout", async () => {
    reconcileBridge.mockResolvedValue({ method: null, skipped: "timeout", actions: [], warnings: [] });
    expect(await install()).toMatchObject({
      status: 504,
      body: { success: false, code: "PANELBRIDGE_INSTALL_STILL_RUNNING" },
    });
  });

  it("500 with a localized code when the copy failed", async () => {
    reconcileBridge.mockResolvedValue({ method: "local", skipped: null, actions: [], warnings: ["installFailed"] });
    expect(await install()).toMatchObject({
      status: 500,
      body: { success: false, code: "PANELBRIDGE_INSTALL_FAILED", serverName: "servertest" },
    });
  });
});
