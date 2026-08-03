import { beforeEach, describe, expect, it, vi } from "vitest";

const createServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
  createServer,
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
}));

const { default: router } = await import("../routes/servers.js");

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

function getCreateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/" && entry.route.methods.post,
  );
  return layer.route.stack[0].handle;
}

describe("POST /api/servers", () => {
  beforeEach(() => {
    createServer.mockReset();
    createServer.mockResolvedValue({ id: "server-id", name: "Test Server" });
  });

  it("persists the setup admin password for first server startup", async () => {
    const response = createResponse();

    await getCreateHandler()(
      {
        body: {
          name: "Test Server",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "rcon-password",
          adminPassword: "first-boot-password",
        },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ adminPassword: "first-boot-password" }),
    );
    expect(response.status).toHaveBeenCalledWith(201);
  });
});
