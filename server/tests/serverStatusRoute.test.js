import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
}));

const fakeBridge = { bridgePath: null, isRunning: false, isModConnected: () => false };
vi.mock("../services/panelBridge.js", () => ({ default: fakeBridge }));

const { default: router } = await import("../routes/serverStatus.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getStatusHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/active/status" && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

function fakeApp(overrides = {}) {
  const services = {
    serverManager: { isRunning: false },
    rconService: { getConfig: () => ({ connected: false }), connecting: false },
    ...overrides,
  };
  return { get: (key) => services[key] };
}

describe("GET /api/servers/active/status", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    fakeBridge.bridgePath = null;
    fakeBridge.isRunning = false;
    fakeBridge.isModConnected = () => false;
  });

  it("returns 404 when no server is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(response.status).toHaveBeenCalledWith(404);
  });

  it("reports container running but RCON disconnected without collapsing to one flag", async () => {
    getActiveServer.mockResolvedValue({ id: 1, isRemote: false });
    fakeBridge.bridgePath = "/data/panelbridge";
    const response = createResponse();

    await getStatusHandler()(
      {
        app: fakeApp({
          serverManager: { isRunning: true },
          rconService: {
            getConfig: () => ({ connected: false, host: "127.0.0.1", port: 27015 }),
            connecting: false,
          },
        }),
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "native",
        selected: true,
        host: expect.objectContaining({ status: "running" }),
        server: expect.objectContaining({ status: "disconnected" }),
        bridge: expect.objectContaining({ status: "offline" }),
      }),
    );
  });

  it("reports an active bridge only when running and mod-connected", async () => {
    getActiveServer.mockResolvedValue({ id: 1, isRemote: false });
    fakeBridge.bridgePath = "/data/panelbridge";
    fakeBridge.isRunning = true;
    fakeBridge.isModConnected = () => true;
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ bridge: expect.objectContaining({ status: "active" }) }),
    );
  });

  it("returns 500 with a sanitized error when the database lookup throws", async () => {
    getActiveServer.mockRejectedValue(new Error("db exploded"));
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(response.status).toHaveBeenCalledWith(500);
  });
});
