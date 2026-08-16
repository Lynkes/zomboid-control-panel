import { beforeEach, describe, expect, it, vi } from "vitest";

const getAllSettings = vi.fn();
const setSetting = vi.fn();
const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getActiveServer,
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

  it("passes through with no req.user when auth is not configured yet", async () => {
    setSetting.mockReset();
    const response = createResponse();

    await runRoute(
      "/app-settings",
      "put",
      { body: { settings: { corsAllowAll: true } }, app: makeApp() },
      response,
    );

    expect(setSetting).toHaveBeenCalledWith("corsAllowAll", true);
  });
});

describe("PUT /api/config", () => {
  it("refuses to write server config while the local server is running", async () => {
    getActiveServer.mockResolvedValue({ isRemote: false });
    const saveServerConfig = vi.fn();
    const response = createResponse();

    await runRoute(
      "/",
      "put",
      {
        body: { config: { serverName: "DoomerZ" } },
        app: {
          get: (key) =>
            key === "serverManager"
              ? {
                  checkServerRunning: vi.fn(async () => true),
                  saveServerConfig,
                }
              : null,
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(saveServerConfig).not.toHaveBeenCalled();
  });
});
