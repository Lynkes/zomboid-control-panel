import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

const getAllSettings = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/config.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

describe("GET /api/config/app-settings", () => {
  beforeEach(() => {
    getAllSettings.mockReset();
  });

  it("masks jwtSecret and discordBotToken (Findings 1 and 3/4)", async () => {
    getAllSettings.mockResolvedValue({
      jwtSecret: "top-secret-jwt-signing-key",
      discordBotToken: "top-secret-discord-token",
      rconPassword: "top-secret-rcon",
      darkMode: true,
    });
    const response = createResponse();

    await runRoute("/app-settings", "get", { app: { get: () => null } }, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.settings.jwtSecret).not.toBe("top-secret-jwt-signing-key");
    expect(payload.settings.discordBotToken).not.toBe(
      "top-secret-discord-token",
    );
    expect(payload.settings.rconPassword).not.toBe("top-secret-rcon");
    expect(payload.settings.darkMode).toBe(true);
  });
});

describe("PUT /api/config/app-settings", () => {
  function makeApp(overrides = {}) {
    const values = { modChecker: null, serverManager: null, rconService: null, ...overrides };
    return { get: (key) => values[key] };
  }

  it("is rejected for a non-admin authenticated user (Finding 5)", async () => {
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      { body: { settings: { corsAllowAll: true } }, user: { role: "viewer" }, app: makeApp() },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("allows an admin to write corsAllowAll", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      {
        body: { settings: { corsAllowAll: true } },
        user: { role: "admin" },
        app: makeApp(),
      },
      response,
    );

    expect(setSetting).toHaveBeenCalledWith("corsAllowAll", true);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("rejects with no req.user at all — requirePermission fails closed now, this is no longer a pass-through case (2026-08-22 fix)", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      { body: { settings: { corsAllowAll: true } }, app: makeApp() },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("auth explicitly disabled: authService.middleware() now sets an explicit synthetic admin req.user (not an absent one), which still works here", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      {
        body: { settings: { corsAllowAll: true } },
        user: { role: "admin", authDisabled: true },
        app: makeApp(),
      },
      response,
    );

    expect(setSetting).toHaveBeenCalledWith("corsAllowAll", true);
  });

  it("returns 400 for a missing body", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      { body: null, user: { role: "admin" }, app: makeApp() },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(setSetting).not.toHaveBeenCalled();
  });

  // 2026-08-26 bug hunt finding 1: this was the one serverName write path
  // that never validated the value at all, unlike routes/servers.js's
  // SERVER_NAME_REGEX for the modern multi-server profile path -- an
  // unvalidated value here reaches an unguarded path.join() downstream in
  // serverManager.js's legacy-settings fallback (getServerConfig/
  // saveServerConfig build `${serverName}.ini`, and the same value names
  // the launched startup script). Rejecting it here is the real fix;
  // serverManagerLegacyServerNameGuard.test.js covers the sink-side defense
  // in depth for a value already stored before this validation existed.
  it("rejects a serverName containing a path-traversal segment (Finding 1)", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      {
        body: { settings: { serverName: "../../../etc/evil" } },
        user: { role: "admin" },
        app: makeApp(),
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects a serverName that is itself an absolute path (Finding 1)", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      {
        body: { settings: { serverName: "/etc/passwd" } },
        user: { role: "admin" },
        app: makeApp(),
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("allows a normal serverName", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      {
        body: { settings: { serverName: "DoomerZ" } },
        user: { role: "admin" },
        app: makeApp(),
      },
      response,
    );

    expect(setSetting).toHaveBeenCalledWith("serverName", "DoomerZ");
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
