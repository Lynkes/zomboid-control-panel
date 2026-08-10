import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const saveTemplate = vi.fn();
const applyTemplate = vi.fn();

vi.mock("../database/init.js", () => ({ getActiveServer }));
vi.mock("../services/templateService.js", () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  saveTemplate,
  deleteTemplate: vi.fn(),
  exportTemplate: vi.fn(),
  importTemplate: vi.fn(),
  previewTemplate: vi.fn(),
  applyTemplate,
}));

const { default: router } = await import("../routes/templates.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runRoute(routePath, method, request, response) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) {
      await handlers[index](request, response, next);
    }
  };
  await next();
}

describe("template mutation routes", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    saveTemplate.mockReset();
    applyTemplate.mockReset();
  });

  it("rejects template creation by a non-admin user", async () => {
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it("rejects applying a template while the active server is running", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: { get: () => ({ checkServerRunning: vi.fn(async () => true) }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("fails closed when active-server state cannot be checked", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: { get: () => ({ checkServerRunning: vi.fn(async () => { throw new Error("scan failed"); }) }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(applyTemplate).not.toHaveBeenCalled();
  });
});