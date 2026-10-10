import { describe, expect, it, vi } from "vitest";

// Saving Settings > Connection ("Auto-reconnect" / "Reconnect interval") must
// reach the running RCON service in the same request, so the change applies
// without a restart. A save that touches neither key must not poke it.

const settingsStore = { panelPort: 3001 };

vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({ ...settingsStore })),
  getSetting: vi.fn(async (key) => settingsStore[key]),
  setSetting: vi.fn(async (key, value) => {
    settingsStore[key] = value;
  }),
  getRoleByName: vi.fn(async () => ({ capabilities: ["panel.settings"] })),
}));

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

async function putAppSettings(settings, rconService) {
  const { default: router } = await import("../routes/config.js");
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
  );
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = createResponse();
  await handler(
    {
      body: { settings },
      user: { role: "admin" },
      app: { get: (name) => (name === "rconService" ? rconService : undefined) },
    },
    res,
  );
  return res;
}

function fakeRconService() {
  return {
    loadConfig: vi.fn(async () => {}),
    loadReconnectSettings: vi.fn(async () => true),
  };
}

describe("PUT /app-settings -- RCON reconnect settings reach the running service", () => {
  it("re-reads them after autoReconnect changes", async () => {
    const rconService = fakeRconService();

    const res = await putAppSettings({ autoReconnect: false }, rconService);

    expect(res.getStatusCode()).toBe(200);
    expect(settingsStore.autoReconnect).toBe(false);
    expect(rconService.loadReconnectSettings).toHaveBeenCalledTimes(1);
  });

  it("re-reads them after reconnectInterval changes", async () => {
    const rconService = fakeRconService();

    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: 30 }, rconService);

    expect(res.getStatusCode()).toBe(200);
    expect(rconService.loadReconnectSettings).toHaveBeenCalledTimes(1);
  });

  it("leaves the service alone when the save touches neither key", async () => {
    const rconService = fakeRconService();

    const res = await putAppSettings({ darkMode: true }, rconService);

    expect(res.getStatusCode()).toBe(200);
    expect(rconService.loadReconnectSettings).not.toHaveBeenCalled();
  });
});
